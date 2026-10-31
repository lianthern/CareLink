"""Create a portable source handoff; never export runtime config or login state."""
import argparse
import datetime
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import zipfile


def command(*args, cwd):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE)


def git(repo, *args):
    return command('git', *args, cwd=repo)


def text(repo, *args):
    return git(repo, *args).decode('utf-8').strip()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    path.write_text(value, encoding='utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    rel = pathlib.PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts:
        raise RuntimeError('Unsafe archive path')
    if any(p in {'.git', '.tools', '.data', 'node_modules'} for p in rel.parts):
        raise RuntimeError('Private/dependency path in tracked source: ' + name)
    if rel.name in {'.env', '.env.local', '.env.production', 'cloudbaserc.local.json'}:
        raise RuntimeError('Private configuration in tracked source: ' + name)
    return rel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path,
                        help='A NEW delivery directory; existing directories are rejected')
    parser.add_argument('--evidence', action='append', default=[], type=pathlib.Path)
    args = parser.parse_args()
    root = pathlib.Path(text(pathlib.Path(__file__).resolve().parent, 'rev-parse', '--show-toplevel'))
    app = root / 'memory-frame-demo'
    reference = args.reference.resolve()
    out = args.output.resolve()
    if out.exists():
        raise RuntimeError('Use a new output directory; never overwrite a delivery')
    if text(root, 'status', '--porcelain'):
        raise RuntimeError('Commit/review project changes before packaging')
    if text(reference, 'status', '--porcelain'):
        raise RuntimeError('Reference has uncommitted work; review before taking a snapshot')
    if text(root, 'branch', '--show-current') != 'main':
        raise RuntimeError('Package the reviewed integrated main branch')
    head = text(root, 'rev-parse', 'HEAD')
    created = datetime.datetime.now().astimezone().isoformat()
    pack = out / 'agent-pack'

    # Scan known project-private values without printing or copying them.
    private_values, fixture_passwords = set(), set()

    def collect(value, key=''):
        if isinstance(value, dict):
            for k, v in value.items():
                collect(v, k)
        elif isinstance(value, list):
            for item in value:
                collect(item, key)
        elif isinstance(value, str) and len(value) >= 8 and re.search(r'token|secret|password|setup.?code|api.?key|^key$', key, re.I):
            private_values.add(value.encode())

    for path in [app / 'cloudbaserc.local.json', *sorted((app / '.tools').glob('*context.json'))]:
        if path.exists():
            value = json.loads(path.read_text(encoding='utf-8-sig'))
            collect(value)
            if path.name == 'cloud-account-acceptance-context.json':
                fixture_passwords.update(item['password'].encode() for item in value.get('credentials', []))
    for path in [app / '.data/setup-code']:
        if path.exists() and len(path.read_bytes().strip()) >= 8:
            private_values.add(path.read_bytes().strip())

    def scan(data, label):
        fixture = label.replace('\\', '/').endswith('test/accounts.test.js')
        if any(v in data for v in private_values if not (fixture and v in fixture_passwords)):
            raise RuntimeError('Known private value detected; content withheld: ' + label)

    names = dict(line.split(' ', 1) if ' ' in line else (line, '')
                 for line in git(root, 'rev-list', '--objects', '--all').decode().splitlines())
    proc = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    blobs = 0
    try:
        for oid, name in names.items():
            proc.stdin.write((oid + '\n').encode())
            proc.stdin.flush()
            header = proc.stdout.readline().split()
            if len(header) != 3:
                raise RuntimeError('Git object scan failed')
            data = proc.stdout.read(int(header[2]))
            if proc.stdout.read(1) != b'\n':
                raise RuntimeError('Incomplete Git object')
            if header[1] == b'blob':
                safe_path(name)
                scan(data, name)
                blobs += 1
    finally:
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError('Git object scan failed')

    worktrees = []
    for block in text(root, 'worktree', 'list', '--porcelain').split('\n\n'):
        fields = dict(line.split(' ', 1) for line in block.splitlines() if ' ' in line)
        location = pathlib.Path(fields['worktree'])
        if text(location, 'status', '--porcelain'):
            raise RuntimeError('Uncommitted worktree: ' + str(location))
        cherry = text(root, 'cherry', 'main', fields['HEAD'])
        pending = sum(line.startswith('+') for line in cherry.splitlines())
        if pending:
            raise RuntimeError('Review unintegrated patches before packaging: ' + str(location))
        worktrees.append({'branch': fields.get('branch'), 'head': fields['HEAD'], 'clean': True,
                          'uniqueUnintegratedPatches': pending,
                          'patchEquivalentCommits': sum(line.startswith('-') for line in cherry.splitlines())})

    def snapshot(repo, destination):
        if any(line.startswith(('120000', '160000')) for line in text(repo, 'ls-tree', '-r', 'HEAD').splitlines()):
            raise RuntimeError('Review symlinks/submodules before packaging')
        count, size = 0, 0
        with zipfile.ZipFile(io.BytesIO(git(repo, 'archive', '--format=zip', 'HEAD'))) as archive:
            if archive.testzip() is not None:
                raise RuntimeError('Invalid source archive')
            for entry in archive.infolist():
                rel = safe_path(entry.filename)
                if entry.is_dir():
                    continue
                data = archive.read(entry)
                scan(data, rel.as_posix())
                target = destination.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                count += 1
                size += len(data)
        return {'commit': text(repo, 'rev-parse', 'HEAD'), 'files': count, 'bytes': size}

    out.mkdir(parents=True)
    project = snapshot(root, pack / 'project')
    ref = snapshot(reference, pack / 'reference-product/unseen-full')
    bundle = pack / 'history/unseenframe.bundle'
    bundle.parent.mkdir(parents=True)
    git(root, 'bundle', 'create', str(bundle), '--all')
    git(root, 'bundle', 'verify', str(bundle))
    write(pack / 'evidence/worktree-audit.json', {'checkedAt': created, 'worktrees': worktrees})
    evidence_names = set()
    for source in args.evidence:
        if source.name in evidence_names:
            raise RuntimeError('Duplicate evidence name')
        evidence_names.add(source.name)
        data = source.read_bytes()
        scan(data, source.name)
        (pack / 'evidence' / source.name).write_bytes(data)
    write(pack / 'PACKAGE-METADATA.json', {
        'product': 'unseen 记忆相框', 'packagedAt': created,
        'project': project, 'reference': {**ref, 'origin': text(reference, 'remote', 'get-url', 'origin')},
        'knownPrivateValueScanPassed': True, 'reachableGitBlobsScanned': blobs,
        'allWorktreesReviewed': True, 'businessTestsRerunByPackager': False,
        'browserMicrophoneCameraGPUVerifiedByPackager': False,
        'exclusions': ['node_modules', '.data', '.tools', '.env', 'cloudbaserc.local.json',
                       'CLI/browser credentials', 'cloud database/media backup'],
        'demoFixtureCaveat': 'Existing account test fixtures match demo account passwords; no production-secrecy claim.'})
    write(pack / '00-先读我.md', f'''# unseen 记忆相框：完整开发交接包

打包时间：{created}。主线提交：`{head}`。

先读 `project/AGENTS.md`、`project/AGENT-HANDOFF.md`、`project/START-HERE.md` 和 `project/memory-frame-demo/HANDOFF.md`。本轮新增摄像头接口和实时 AI 语音接口的完成范围、部署状态与实测边界，以这些文件顶部最新记录为准。

- `project/` 包含全部跟踪源码、测试、锁文件、自托管资源、原始 Demo 和文档。
- 摄像头调查及接口：`project/memory-frame-demo/docs/CAMERA-LINK2-RESEARCH.md`、`CAMERA-INTERFACE.md`。
- 聊天入口及腾讯 TRTC 实时语音接入：`project/memory-frame-demo/docs/AI-REALTIME.md`。
- `reference-product/unseen-full/` 是完整 UNSEEN 参考快照；只用于理解产品，不修改旧服务。
- `history/unseenframe.bundle` 包含所有项目分支与历史，两个新 worktree 的提交也在其中。
- `evidence/` 保存本次提供的测试日志及补丁等价检查；打包本身不代表业务或硬件验收。

恢复历史到一个新目录：

```powershell
git clone --branch main ./history/unseenframe.bundle ./unseenframe
```

依赖安装与本地运行按 `project/START-HERE.md`；新实例使用独立数据目录。当前包不含部署密钥、账号会话、个人本地数据及可重装的依赖目录，也不是云端家庭数据备份。原始 SDK 使用文档内官方入口获取。

原源码中的演示账号测试样例与线上演示凭据存在重合，不能把演示账号视为保密生产账号。此包用于交付到本人网盘，是否上传成功以交付消息为准；没有生成公开分享。

首次解压后、安装依赖前，可运行 `python verify-package.py` 校验逐文件摘要。外层 ZIP 摘要见交付目录的 `DELIVERY-CHECKSUMS.sha256`。
''')
    verifier = '''import hashlib, pathlib
root = pathlib.Path(__file__).resolve().parent
expected = {}
for line in (root / 'MANIFEST.sha256').read_text(encoding='utf-8').splitlines():
    value, name = line.split('  ', 1)
    rel = pathlib.PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts:
        raise SystemExit('Unsafe path')
    expected[name] = value
for name, value in expected.items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != value:
        raise SystemExit('Hash mismatch: ' + name)
actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
if actual != set(expected) | {'MANIFEST.sha256'}:
    raise SystemExit('Unexpected/missing files')
print('OK:', len(expected), 'files verified')
'''
    write(pack / 'verify-package.py', verifier)
    entries = {}
    for path in sorted(pack.rglob('*')):
        if path.is_file():
            data = path.read_bytes()
            if path.suffix != '.bundle':
                scan(data, path.relative_to(pack).as_posix())
            entries[path.relative_to(pack).as_posix()] = digest(data)
    write(pack / 'MANIFEST.sha256', ''.join(value + '  ' + name + '\n' for name, value in entries.items()))
    command(sys.executable, str(pack / 'verify-package.py'), cwd=pack)
    target = out / ('unseen-memory-frame-complete-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(pack.rglob('*')):
            if path.is_file():
                archive.write(path, 'agent-pack/' + path.relative_to(pack).as_posix())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(entries) + 1:
            raise RuntimeError('ZIP verification failed')
        for name, value in entries.items():
            if digest(archive.read('agent-pack/' + name)) != value:
                raise RuntimeError('ZIP hash mismatch')
    restore = out / 'restore-check'
    command('git', 'clone', '--branch', 'main', str(bundle), str(restore), cwd=out)
    if text(restore, 'rev-parse', 'HEAD') != head or text(restore, 'ls-tree', '-r', 'HEAD') != text(root, 'ls-tree', '-r', 'HEAD'):
        raise RuntimeError('Bundle restore mismatch')
    if text(restore, 'status', '--porcelain'):
        raise RuntimeError('Restored repository is dirty')
    result = {'sourceCommit': head, 'zip': str(target), 'bytes': target.stat().st_size,
              'sha256': digest(target.read_bytes()), 'manifestFiles': len(entries),
              'project': project, 'reference': ref, 'worktrees': len(worktrees),
              'portableGitCloneVerified': True, 'knownPrivateValueScanPassed': True}
    write(out / 'DELIVERY-VERIFICATION.json', result)
    write(out / 'DELIVERY-CHECKSUMS.sha256', result['sha256'] + '  ' + target.name + '\n')
    write(app / '.tools/latest-complete-delivery.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
