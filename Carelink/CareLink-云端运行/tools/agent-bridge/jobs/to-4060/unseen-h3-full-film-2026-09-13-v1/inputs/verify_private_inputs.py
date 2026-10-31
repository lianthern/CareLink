"""Verify the frozen private media asset; optionally extract into a new directory.

Run only from the exact Receive-BridgeJob result PayloadRoot after its manifest
passes. This verifies media; it never claims to have received the control job.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def safe_name(name):
    if not name or len(name) > 240 or '\\' in name or name.startswith('/'):
        raise ValueError('Unsafe member path')
    for part in name.split('/'):
        if (part in ('', '.', '..') or part.endswith((' ', '.'))
                or re.search(r'[\x00-\x1f<>:"|?*]', part)
                or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])', part.split('.')[0])):
            raise ValueError('Unsafe Windows member path')
    return PurePosixPath(name)


def verify(lock, archive):
    if archive.is_symlink() or not archive.is_file():
        raise ValueError('Archive must be a regular file')
    if archive.stat().st_size != lock['bytes'] or digest(archive) != lock['sha256']:
        raise ValueError('Private archive bytes/SHA mismatch; preserve and quarantine it')
    records = lock['files']
    expected = {r['path']: r for r in records}
    if len(expected) != lock['fileCount'] or len(records) != len(expected):
        raise ValueError('Invalid frozen inventory')
    folded = set()
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        if len(entries) != len(expected) or {i.filename for i in entries} != set(expected):
            raise ValueError('ZIP member coverage mismatch')
        if sum(i.file_size for i in entries) != lock['expandedBytes']:
            raise ValueError('Expanded size mismatch')
        for info in entries:
            safe_name(info.filename)
            if info.filename.casefold() in folded:
                raise ValueError('Duplicate/case-colliding ZIP member')
            folded.add(info.filename.casefold())
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or info.flag_bits & 1:
                raise ValueError('Non-regular/encrypted ZIP member')
            r = expected[info.filename]
            if info.file_size != r['bytes'] or info.file_size > lock['maxMemberBytes']:
                raise ValueError('Member byte bound mismatch')
            h = hashlib.sha256()
            size = 0
            with z.open(info) as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    size += len(block)
                    if size > r['bytes']:
                        raise ValueError('ZIP expanded beyond member bound')
                    h.update(block)
            if size != r['bytes'] or h.hexdigest() != r['sha256']:
                raise ValueError('ZIP member SHA mismatch: ' + info.filename)
    return records


def verify_tree(root, records):
    for r in records:
        p = root.joinpath(*safe_name(r['path']).parts)
        for part in (p, *p.parents):
            if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
                raise ValueError('Link/junction in extracted path')
            if part == root:
                break
        if not p.is_file() or p.stat().st_size != r['bytes'] or digest(p) != r['sha256']:
            raise ValueError('Extracted member mismatch: ' + r['path'])
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != {r['path'] for r in records}:
        raise ValueError('Unexpected extracted files')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--extract', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    records = verify(lock, args.archive)
    if args.extract:
        for p in (args.extract, *args.extract.parents):
            if p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()):
                raise ValueError('Extraction target has a link/junction')
        if args.extract.exists():
            verify_tree(args.extract, records)
        else:
            args.extract.parent.mkdir(parents=True, exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix=args.extract.name + '.staging-', dir=args.extract.parent))
            with zipfile.ZipFile(args.archive) as z:
                for r in records:
                    target = stage.joinpath(*safe_name(r['path']).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(r['path']) as source, target.open('xb') as dest:
                        for block in iter(lambda: source.read(1024 * 1024), b''):
                            dest.write(block)
            verify_tree(stage, records)
            # Never overwrite an existing target; all failed stages are retained.
            if args.extract.exists():
                raise ValueError('Concurrent extraction target appeared')
            stage.rename(args.extract)
    report = dict(schemaVersion='1.0', jobId=lock['jobId'], state='INPUTS-VERIFIED',
                  verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  host=os.environ.get('COMPUTERNAME') or os.uname().nodename,
                  manifestSha256=digest(args.manifest), assetName=lock['assetName'],
                  actualBytes=args.archive.stat().st_size, actualSha256=digest(args.archive),
                  fileCount=len(records), expandedBytes=lock['expandedBytes'], files=records,
                  extracted=args.extract is not None, verifierSha256=digest(Path(__file__)))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open('x', encoding='utf-8') as out:
        json.dump(report, out, ensure_ascii=False, indent=2)
        out.write('\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'files'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
