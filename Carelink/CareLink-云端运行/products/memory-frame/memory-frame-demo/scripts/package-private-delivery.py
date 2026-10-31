"""Build an explicitly authorized private handoff with portable preview and access files."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    path.write_text(value, encoding='utf-8')


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except Exception:
        raise RuntimeError('Invalid input file; private contents withheld') from None


def safe_tree(directory):
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            entry = pathlib.Path(parent) / name
            if entry.is_symlink() or entry.is_junction():
                raise RuntimeError('Portable inputs must contain ordinary files, not links')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-pack', 'content', 'dependencies', 'node', 'node-license', 'private-config', 'private-accounts', 'output']:
        parser.add_argument('--' + name, required=True, type=pathlib.Path)
    args = parser.parse_args()
    source, content, deps, out = (getattr(args, name).resolve() for name in ['source_pack', 'content', 'dependencies', 'output'])
    if out.exists():
        raise RuntimeError('Choose a new output directory; no delivery is overwritten')
    if any(out == directory or out.is_relative_to(directory) for directory in [source, content, deps]):
        raise RuntimeError('Output must be outside every input tree')
    # The public source pack has already audited Git history/worktrees and scanned secrets.
    expected = {}
    for line in (source / 'MANIFEST.sha256').read_text(encoding='utf-8').splitlines():
        sha, name = line.split('  ', 1)
        rel = pathlib.PurePosixPath(name)
        if rel.is_absolute() or pathlib.PureWindowsPath(name).drive or '\\' in name or '..' in rel.parts:
            raise RuntimeError('Invalid source manifest path')
        if name in expected:
            raise RuntimeError('Duplicate source manifest path')
        expected[name] = sha
        if digest(source.joinpath(*rel.parts).read_bytes()) != sha:
            raise RuntimeError('Source pack hash mismatch')
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()}
    if actual != set(expected) | {'MANIFEST.sha256'}:
        raise RuntimeError('Source pack contains unexpected or missing files')
    metadata = read_json(source / 'PACKAGE-METADATA.json')
    config = read_json(args.private_config)
    if config.get('envId') != 'memory-frame-demo-d7djiee0702b6c':
        raise RuntimeError('Only the explicitly selected demo environment is allowed')
    functions = config.get('functions', [])
    if len(functions) != 1 or functions[0].get('name') != 'memory-frame-demo':
        raise RuntimeError('Unexpected private deployment scope')
    context = read_json(args.private_accounts)
    credentials = context.get('credentials', context.get('accounts', []))
    if len(credentials) != 2 or not all(isinstance(item.get('username'), str) and isinstance(item.get('password'), str) for item in credentials):
        raise RuntimeError('Expected the two explicitly selected demo accounts')
    for directory in [source, content, deps]:
        safe_tree(directory)
    server = source / 'project/memory-frame-demo/server'
    if (server / 'pnpm-lock.yaml').read_bytes() != (deps.parent / 'pnpm-lock.yaml').read_bytes():
        raise RuntimeError('Runtime dependencies must use the source server lockfile')
    local_accounts = read_json(content / 'private-access/local-preview-accounts.json')
    if local_accounts.get('scope') != 'local-preview-only':
        raise RuntimeError('Expected isolated preview credentials')
    content_summary = read_json(content / 'content-summary.json')
    # Short archive/root names leave room for the full reference tree on Windows.
    root = out / 'unseen'
    root.mkdir(parents=True)
    shutil.copytree(source, root / 'development')
    shutil.copytree(server, root / 'preview/server')
    # Hoisted production dependencies are normal files, independent of any pnpm store.
    shutil.copytree(deps, root / 'preview/server/node_modules', ignore=shutil.ignore_patterns('.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json'))
    shutil.copytree(content, root / 'content', ignore=shutil.ignore_patterns('private-access'))
    shutil.copytree(content / 'private-access', root / 'private-access')
    runtime = root / 'runtime'
    runtime.mkdir()
    shutil.copy2(args.node, runtime / 'node.exe')
    shutil.copy2(args.node_license, runtime / 'NODE-LICENSE.txt')
    node_version = subprocess.check_output([str(runtime / 'node.exe'), '--version'], text=True).strip()
    write(runtime / 'ORIGIN.txt', 'Node.js ' + node_version + ' Windows x64\nSupplied from the existing bundled local runtime; no installer required.\nLicense: https://raw.githubusercontent.com/nodejs/node/' + node_version + '/LICENSE\nSHA-256 node.exe: ' + digest((runtime / 'node.exe').read_bytes()) + '\n')
    templates = pathlib.Path(__file__).resolve().parent / 'portable'
    for name in ['launch-local.cjs', 'verify-package.cjs', 'START-WINDOWS.cmd', 'START-MAC-LINUX.sh', 'VERIFY-WINDOWS.cmd']:
        shutil.copy2(templates / name, root / name)
    write(root / 'OPEN-ONLINE.url', '[InternetShortcut]\nURL=https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family\n')
    write(root / 'OPEN-FRAME.url', '[InternetShortcut]\nURL=https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame\n')

    # User explicitly requested project/server access in this private delivery.
    # Never copy the whole .tools tree, browser profile, CLI login state or sessions.
    private = root / 'private-access'
    shutil.copy2(args.private_config, private / 'cloudbaserc.local.json')
    online = [{key: item[key] for key in ['username', 'password', 'nickname', 'role'] if key in item} for item in credentials]
    write(private / 'online-demo-accounts.json', {'scope': 'existing-demo-only', 'origin': 'https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com', 'accounts': online})
    rows = ['unseen 记忆相框：线上访问与服务端接手', '', '家人端：https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/family',
            '相框端：https://memory-frame-demo-d7djiee0702b6c.service.tcloudbase.com/frame', '', '现有演示账号（由项目所有者授权放入本次私有交接包）：']
    for account in online:
        rows += ['账号：' + account['username'], '密码：' + account['password'], '']
    rows += ['日常登录不需要开通码。原服务仍是腾讯云 CloudBase 云函数，不是 SSH 虚拟机；没有可填写的 SSH 地址/密码。',
             '环境：memory-frame-demo-d7djiee0702b6c；地域：上海；函数：memory-frame-demo；运行时：Nodejs20.19。',
             '云控制台：https://console.cloud.tencent.com/tcb',
             'cloudbaserc.local.json 包含当前函数资源和服务端私有配置（包括项目开通码及识图 Key），按用户本次授权交接。',
             '此文件不能放入 public/ 或提交 Git；本地预览不会读取它。',
             '要更新现有云服务：进入 development/project/memory-frame-demo，复制本目录的 cloudbaserc.local.json 到该目录；',
             '安装 Node.js 与 pnpm，运行 pnpm install --frozen-lockfile，再在 server 子目录同样安装依赖；',
             '返回 memory-frame-demo，运行 node node_modules/@cloudbase/cli/bin/tcb login --flow device，用获授权的腾讯云账号重新登录；',
             '代码审核后运行 node scripts/deploy.mjs --update。部署脚本固定原环境，不能作为新环境部署脚本直接使用。',
             '本包没有导出电脑浏览器登录态、CLI缓存、腾讯云主账号密码或现存云会话。服务管理仍需接手人自己的获授权云登录。',
             '项目所有者随后重置登录方式；项目当前没有在线修改账号密码界面，修改服务端 Key 后应同步私有部署配置。',
             '实时AI尚未开通；说明见 development/project/memory-frame-demo/docs/TENCENT-VOICE-OPTIONS.md。']
    write(private / 'ONLINE-AND-SERVER-ACCESS.txt', '\n'.join(rows) + '\n')
    write(root / '00-打开方式.txt', '''unseen 记忆相框：可运行的私有交接包

先将整个ZIP解压到可写的较短路径（例如 C:\\unseen），不要在压缩软件里直接运行。

一、直接访问已有在线版本
双击 OPEN-ONLINE.url。账号见 private-access/ONLINE-AND-SERVER-ACCESS.txt。
线上可以使用当前已配置的文字聊天和识图；实时语音尚未开通。

二、Windows 本地打开已有内容（不必安装开发环境）
双击 START-WINDOWS.cmd，浏览器会打开本地地址。
登录资料见 private-access/LOCAL-PREVIEW-LOGIN.txt；本地账号与线上账号不同。
保持启动窗口打开，结束时按 Ctrl+C。重复双击不会启动第二个数据写入实例。
包含现有照片、音频、文字、人物、回执和3D内容快照；实际数量见 content/content-summary.json。
离线浏览已有内容不调用云服务。AI生成、识别和实时语音不在离线包内运行，需要联网配置或使用在线版本。
第一次运行从 content/seed-data 复制到 preview/data，后续本地修改保存在 preview/data，不改原始快照或线上数据。
这是导出时账号可见的家庭内容，不是云后台所有账号、已删除数据或供应商任务的数据库备份。

三、Mac/Linux
已有 Node.js 20.19+ 或24 LTS时，在包目录执行 sh START-MAC-LINUX.sh。
Windows运行时已附，Mac/Linux使用本机Node；本次实际验证平台是Windows。

四、开发与服务器接手
development/project：完整当前项目源码、测试和文档。
development/history/unseenframe.bundle：所有项目分支/历史，可 git clone --branch main 到新目录。
development/reference-product/unseen-full：完整UNSEEN参考源码；旧服务和DNS未改。
private-access：本次授权放入的演示账号、当前云部署私有配置与服务器访问步骤。
最先读 development/project/AGENT-HANDOFF.md 和 START-HERE.md。
TRTC也是腾讯，但不是必需；替代路线和现有未开通状态见 TENCENT-VOICE-OPTIONS.md。

五、检查与证据
Windows双击 VERIFY-WINDOWS.cmd，检查原始交付文件的SHA-256；运行后新增的preview/data不参与原始清单。
开发包的历史/源码校验和业务验收在 development/evidence 与 development/project/memory-frame-demo/docs。
content/verification 为内容恢复检查。真实麦克风、摄像头、实时语音和GPU效果不由打包校验代替。
此包按项目所有者授权含私有访问资料，由所有者自行上传转交；本次没有上传网盘。
''')
    write(root / 'DELIVERY-METADATA.json', {
        'product': 'unseen 记忆相框', 'createdAt': datetime.datetime.now().astimezone().isoformat(),
        'sourceCommit': metadata['project']['commit'], 'liveVersion': '0.4.5', 'liveCodeCommit': '561c6ecfd62c91f26456aa6918c9b4575f49f711',
        'node': node_version, 'platformTested': 'windows-x64', 'containsPrivateAccessByUserRequest': True,
        'cloudLoginSessionsIncluded': False, 'browserOrCLILoginStateIncluded': False,
        'cloudDataBackupScope': 'current-family-content-visible-to-selected-accounts',
        'contentSummary': content_summary, 'localPreviewCallsCloudAI': False, 'uploadedToCloudDrive': False})
    files = {p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file()}
    write(root / 'FILE-MANIFEST.json', {'algorithm': 'SHA-256', 'files': files})
    subprocess.run([str(runtime / 'node.exe'), str(root / 'verify-package.cjs')], cwd=root, check=True)
    target = out / ('unseen-' + datetime.datetime.now().strftime('%Y%m%d-%H%M') + '.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for p in sorted(root.rglob('*')):
            if p.is_file():
                archive.write(p, 'unseen/' + p.relative_to(root).as_posix())
    with zipfile.ZipFile(target) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(files) + 1:
            raise RuntimeError('ZIP verification failed')
        for name, sha in files.items():
            if digest(archive.read('unseen/' + name)) != sha:
                raise RuntimeError('ZIP content hash mismatch')
    result = {'zip': str(target), 'sourceCommit': metadata['project']['commit'], 'bytes': target.stat().st_size,
              'sha256': digest(target.read_bytes()), 'manifestFiles': len(files), 'containsPrivateAccessByUserRequest': True,
              'hashVerified': True, 'extractedStartupVerified': False, 'uploadedToCloudDrive': False}
    write(out / 'DELIVERY-VERIFICATION.json', result)
    write(out / 'DELIVERY-CHECKSUMS.sha256', result['sha256'] + '  ' + target.name + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
