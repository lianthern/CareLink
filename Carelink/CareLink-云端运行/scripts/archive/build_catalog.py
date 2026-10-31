#!/usr/bin/env python3
"""Export searchable metadata from the owner's private capture directory."""
import argparse
import base64
import collections
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def sanitize(value):
    value = re.sub(r"https?://[^\s)\]<>]+", "[链接见加密原件]", value)
    value = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b", "[凭证已隐藏]", value)
    value = re.sub(r"(?i)((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+", r"\1[已隐藏]", value)
    return " ".join(value.split())


def category(row):
    suffix = Path(row["path"]).suffix.lower()
    if row["source"] in ("git-history", "working-changes", "capture-metadata") or "/.git/" in "/" + row["path"]:
        return "历史与修改"
    if row["kind"] == "symlink":
        return "链接记录"
    if suffix in (".md", ".txt", ".org", ".rst", ".pdf", ".docx", ".pptx", ".key"):
        return "文档与草稿"
    if suffix in (".mp4", ".mov", ".webm", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".flac"):
        return "视频与录音"
    if suffix in (".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".svg", ".tiff", ".avif"):
        return "图片与截图"
    if suffix in (".ply", ".sog", ".splat", ".glb", ".gltf", ".obj", ".fbx", ".pth", ".pt", ".safetensors", ".onnx"):
        return "空间与模型"
    if suffix in (".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".html", ".css", ".swift", ".rs", ".go", ".cpp", ".h", ".vue", ".sql"):
        return "代码与实验"
    return "数据与其他"


def write_gzip(path, content):
    path.write_bytes(gzip.compress(content.encode("utf-8"), compresslevel=9, mtime=0))


def generate(capture, destination):
    destination.mkdir(parents=True, exist_ok=True)
    sources = json.loads((capture / "sources.private.json").read_text())
    source_map = {s["id"]: sanitize(s["label"]) for s in sources}
    for name in ("git-history", "working-changes", "capture-metadata"):
        source_map[name] = name
    raw = [json.loads(line) for line in (capture / "files.private.jsonl").read_text().splitlines()]
    for name in ("extra-files.private.json", "supplemental-files.private.json"):
        if (capture / name).exists():
            raw.extend(json.loads((capture / name).read_text()))
    objects = json.loads((capture / "objects.private.json").read_text())
    packs = json.loads((capture / "packs.private.json").read_text())
    repo_files = {}
    code_commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    modified = set(subprocess.check_output(["git", "-C", str(ROOT), "diff", "--name-only", "-z", "HEAD"]).decode().split("\0"))
    tracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"]).decode().split("\0")
    for name in tracked:
        p = ROOT / name
        if name and name not in modified and p.is_file() and not p.is_symlink() and not name.startswith("archive/catalog/"):
            with p.open("rb") as f:
                digest = hashlib.file_digest(f, "sha256").hexdigest()
            repo_files.setdefault(digest, name)
    titles = {}
    public = []
    for row in raw:
        sha = row.get("sha256")
        obj = objects.get(sha)
        complete = bool(obj and sum(p["bytes"] for p in obj["parts"]) == row["bytes"] and all(0 <= p["pack"] < len(packs) for p in obj["parts"]))
        status = "archived" if complete else ("link-metadata" if row["kind"] == "symlink" else "pending")
        item = {"id": row["id"], "source": source_map[row["source"]], "sourceId": row["source"],
                "path": sanitize(row["path"]), "bytes": row["bytes"], "kind": row["kind"], "status": status,
                "category": category(row), "mtime": row["mtime"], "mode": row.get("mode", 0)}
        if sha:
            item["sha256"] = sha
        if sha in repo_files:
            item["repoPath"] = repo_files[sha]
        if Path(row["path"]).suffix.lower() in (".md", ".rst") and sha and row["bytes"] < 2_000_000:
            if sha not in titles:
                try:
                    with Path(row["localPath"]).open("r", encoding="utf-8", errors="replace") as f:
                        lines = f.read(16000).splitlines()
                    headings = [sanitize(line.lstrip("# ")) for line in lines if re.match(r"^#{1,2} [^#]", line)]
                    headings = [s[:140] for s in headings if "PRIVATE KEY" not in s and "AGE-SECRET" not in s]
                    titles[sha] = " · ".join(headings[:3])[:360]
                except OSError:
                    titles[sha] = ""
            if titles[sha]:
                item["title"] = titles[sha]
        public.append(item)
    files_text = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in public)
    write_gzip(destination / "files.jsonl.gz", files_text)
    write_gzip(destination / "objects.json.gz", json.dumps(objects, separators=(",", ":")))
    (destination / "packs.json").write_text(json.dumps(packs, indent=2) + "\n")
    (destination / "sources.json").write_text(json.dumps([{"id": s["id"], "label": source_map[s["id"]], "selection": s.get("selection", "directory")} for s in sources], ensure_ascii=False, indent=2) + "\n")
    original = raw[:len(raw) - sum(len(json.loads((capture / n).read_text())) for n in ("extra-files.private.json", "supplemental-files.private.json") if (capture / n).exists())]
    unique = {r["sha256"]: r["bytes"] for r in original if r["kind"] == "file"}
    kinds = collections.Counter(r["status"] for r in public)
    coverage = {
        "schema": "unseen-archive-catalog/1", "snapshot": "20260920", "repository": "maxi-max-dev/unseen", "tag": "unseen-archive-20260920",
        "codeCommit": code_commit,
        "catalogBuiltAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "captureMode": "逐文件校验的归档快照；不是多目录同一时刻的原子快照",
        "sourceDirectories": sum("selection" not in s for s in sources), "selectedFileCollections": sum("selection" in s for s in sources),
        "sourceLocations": len(sources), "registeredWorktrees": len(json.loads((capture / "worktrees.private.json").read_text())),
        "originalEntries": len(original), "originalUniqueFiles": len(unique), "originalUniqueBytes": sum(unique.values()),
        "catalogEntries": len(public), "states": dict(kinds), "capsules": len(packs), "encryptedUploadedBytes": sum(p["bytes"] for p in packs),
        "gitDatabases": len(json.loads((capture / "histories.private.json").read_text())),
        "additionalRawGitEntries": sum("/.git/" in "/" + r["path"] for r in public),
        "categories": dict(collections.Counter(r["category"] for r in public)),
        "icloud": {"entries": sum("com~apple~CloudDocs" in r["source"] for r in public), "pending": sum("com~apple~CloudDocs" in r["source"] and r["status"] not in ("archived", "link-metadata") for r in public)},
        "excluded": ["可重新安装的 node_modules / venv / Python 缓存", ".git 原目录改为 Git bundle 保存", ".DS_Store", "本次新建的归档工作目录（由本仓库 Git 提交保存）"],
        "notCaptured": ["服务器当前数据库和用户上传原件（本机已有备份副本已收录）", "4060 / WSL 设备上尚未同步到本机的文件", "未挂载或未发现的其他设备与目录", "符号链接的目标若在扫描来源之外，只保留链接记录"],
        "recoveryKey": "恢复密钥独立保存，不在仓库或附件中。持有人须另行保管；没有密钥无法恢复加密原件。",
        "automaticCapture": False,
    }
    if (capture / "recipient.txt").exists():
        coverage["ageRecipient"] = (capture / "recipient.txt").read_text().strip()
    (destination / "coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, indent=2) + "\n")
    histories = []
    for history in json.loads((capture / "histories.private.json").read_text()):
        file = history.get("file", {})
        histories.append({"source": sanitize(history.get("worktree", history["commonDir"]).replace(str(Path.home()) + "/", "~/")),
                          "status": history["status"], "fileId": file.get("id"), "bytes": file.get("bytes"),
                          "refs": [sanitize(ref) for ref in history.get("refs", [])]})
    (destination / "histories.json").write_text(json.dumps(histories, ensure_ascii=False, indent=2) + "\n")
    payload = base64.b64encode(gzip.compress(files_text.encode(), compresslevel=9, mtime=0)).decode()
    template = (ROOT / "scripts/archive/search.template.html").read_text()
    page = template.replace("__FILES_GZIP_BASE64__", payload).replace("__COVERAGE_JSON__", json.dumps(coverage, ensure_ascii=False).replace("<", "\\u003c"))
    (destination / "search.html").write_text(page)
    print(json.dumps({"entries": len(public), "states": dict(kinds), "catalogBytes": len(files_text.encode()), "htmlBytes": len(page.encode())}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="本机私有扫描与上传回执目录")
    parser.add_argument("--output", type=Path, default=ROOT / "archive/catalog/20260920")
    args = parser.parse_args()
    generate(args.capture, args.output)
