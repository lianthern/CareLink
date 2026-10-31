# 双仓候选、迁移及恢复合同（未部署）

## 实际入口与模板不同

2026-09-05只读SSH现场证据：`unseen-operable.service` active，ExecStart为`/usr/local/bin/node infra/integration/local-operable.mjs`；WorkingDirectory为`/opt/unseen/releases/8d366ec22d82f49ea4da36b84a77c6bf15aa77a7`，Git HEAD也已只读验证同SHA。服务实际端口4300；携带Host `unseen.maxxam.xyz`的loopback GET `/__book_lab_web__/src/integrated-shell.mjs`返回200，未携带预期Host返回400。这证明生产已有该模块路径，不能依据模板声称线上404。

canonical `ops/release/unseen.service.example` 是另一条production-package路径，使用 `infra/integration/book-lab/deployment-entrypoint.mjs`，内部same-origin-server原仅旧`/packages/book-lab-web/src/*`。canonical提交`07d9062514048b45ba739a5adc01edaaa03b93c3`补上新namespace别名和catalog；保留旧路径，只复用明确公开文件白名单，不增加任意文件路由。新旧路径逐字节HTTP测试通过。此变更不切换生产进程入口。

## 配对发布清单必须先冻结

每次候选记录：App完整commit+tree、canonical完整commit+tree、两个实际入口及公开origin/后端可信Host、完整资源hash、canonical迁移文件名和hash、当前DB schema_migrations、旧版成套commit、固定数据目录、keyset备份标识、媒体备份标识，以及恢复点时间。不得以两个仓库的HEAD浮动引用替代精确配对。

HUIJIAN状态（photo-ai-usage.json、worldlabs-usage.json、world-jobs.json）与canonical状态独立持久，均不打进代码release目录。canonical核心状态来自`UNSEEN_LOCAL_DATA_DIR`下unseen.sqlite、local.keyset.json、media目录及相关持久状态；读取当前配置确认路径，不凭文件名猜生产。secret/env只记录名称与受保护备份标识，不写值进发布清单。keyset绝不能重新生成来“修复”旧数据库。

## 本地可复跑证据

`node deploy/dual-release-rehearsal.mjs --app-source ABS_APP --app-sha FULL_SHA --canonical-source ABS_CANONICAL --canonical-sha FULL_SHA --previous-canonical-sha FULL_PREVIOUS_SHA --root ABS_NEW_PATH_UNDER_DOT_TASK`

工具只接受新的.task目录和3个完整commit，Git archive冻结两个仓库及真实旧canonical。它用历史迁移代码建立合成SQLite+真实格式本地keyset+测试媒体，停止全部写者后成套备份。新版真实local-operable启动会执行实际canonical迁移；新版HUIJIAN真实server进程代理到它，验证4个Book模块及catalog字节hash、未知模块404。停止两进程后注入失败状态，再保留失败目录、从备份恢复完整数据，验证SQLite integrity、迁移前marker、keyset与媒体字节不变，最后重新启动真实旧canonical入口并检查health。假供应商key和disabled worker/OTP/locator模式，不触碰线上数据或付费接口。

已执行配对：App ff3587e231f9a5ad30b1ccaa57ef03a9a727dff0，canonical 07d9062514048b45ba739a5adc01edaaa03b93c3；旧canonical为现场真实8d366ec22d82f49ea4da36b84a77c6bf15aa77a7。证据`.task/unseen-app/dual-release-evidence/rehearsal-02/receipt.json`。首次演练因测试媒体目录权限错误被拒绝，记录run-01.log保留；修正测试fixture权限为0700/0600后第二次通过。此配对是独立接缝验证，最终SHA变化必须再跑，不冒充最终整合候选。

## 生产迁移/恢复操作设计（未执行）

1. 新双仓release、env和服务启动计划先stage/hash检查，先用目标状态副本演练真实迁移。openDatabase按文件逐个事务自动迁移，多个迁移整体不是一个事务；版本切回不等于数据库回退，绝不假设旧代码兼容新版schema。
2. 进入明确维护窗口，阻止新写入并停止canonical API/worker/CLIP及App，确认其他写者停止。对canonical SQLite做完整备份（关闭连接后整个目录副本；若不停机方案必须SQLite备份API且另行保证媒体一致性，不能单cp活跃WAL数据库）。保存数据库、仍存在的wal/shm、keyset、媒体及配置/secret的受保护备份；记录权限和可复核备份校验。保留前一版代码/runtime/CLIP venv模型引用。
3. 以候选canonical启动完成迁移，检查schema_migrations、integrity/foreign-key检查、owner会话、private媒体授权与Book路径；再启App配对并复验其代理。两进程切换不是一个跨进程原子操作，维护窗口内序列化，全部通过才开放流量。此工具仅验证local fixture，不能替代目标机依赖和真实数据兼容验收。
4. 任一步失败：维持维护阻断；停止所有新写者；将失败数据目录整体移到隔离保存位置（不要覆盖/删除）；把完整备份恢复到新目录并核hash、owner/mode，再将固定数据目录指向恢复版；恢复原双仓版本、匹配env/secret和原keyset，启动旧canonical再旧App并复验。禁止在新版迁移后的DB上直接运行旧代码并称“已回退”。
5. 若已开放用户写入，恢复发布前快照会丢失之后的新数据；必须先保留当前全量状态，选择经过验证的前滚修复或单独批准的数据合并/恢复方案，不能自动套用快照回退。故本设计默认在维护窗口、开放流量前决定是否恢复。

`release-candidate.mjs`的单仓原子current/previous不变；现有HUIJIAN install.sh仍inplace，实际canonical单元为unseen-operable，不得拿模板unseen.service覆盖它。生产版本化方案仍需最终获准的服务路径/启动方式和双仓配对清单。本轮没有运行安装、systemctl写操作、迁移生产DB或修改远程Git配置。

## R2/R3 修正：v2 可执行配对生命周期

此前v1证据只覆盖canonical状态恢复，Book关闭且没有重新启动旧App；不能称“双仓全部恢复”。v1收据保留为历史有限证据。本节取代上面的可复跑命令范围描述。

v2命令新增必填 `--previous-app-sha FULL_PREVIOUS_APP_SHA`。脚本对新旧两对代码完整Git archive，形成pairs/previous.json和pairs/candidate.json（完整SHA、绝对入口、逐文件hash）；每次选择版本重新验证staged hash，然后原子rename `current` 配对指针。不是各自单独更新两个浮动HEAD。

本地维护网关是真实HTTP服务：停服务之前切到503并测试；两服务全启动、直接后端检查通过之后才开放网关200。v2执行旧配对→维护→备份两边状态→候选配对→真实两服务HTTP→注入post-switch gate失败→维护→停止两服务→保留失败状态目录→成套恢复→选择旧配对→重启旧canonical和旧App→网关200验证。最终为停止后的维护503状态，所有子进程退出；不是操作系统级同时原子启动。

持久App fixture用实际库写出photo-ai-usage.json已用预算、worldlabs-usage.json已用额度及world-jobs.json unknown任务。备份/恢复包含这三个文件；重启旧App后真实HTTP检索原owner的unknown任务与World剩余额度4，读取预算hash无重置。canonical侧保留真实18→19迁移、keyset、SQLite、媒体成套恢复及完整性检测。所用旧App为明确指定的历史ff3587e（支持jobs HTTP恢复接口）；不是声称它就是现场生产App版本。

Book在新旧运行中均开启并实际mounted；候选renderWorker=true（真实本地timer worker启动，但**没有提交渲染任务，不证明renderer产出或系统依赖就绪**）；真实旧canonical8d366ec没有local render worker支持，收据明确记录。privateAiWorker始终false，不能称私有AI worker在线或执行通过。真实生产CLIP模型/venv、私有worker/OTP/provider、renderer运行及操作系统沙箱仍需各自目标环境证据。

开发验证配对仍为f7d2f0d/7533bcb，旧App ff3587e与旧canonical8d366ec。v2-paired收据是实现验证，不是新最终冻结验收。最终候选变更后重新传完整配对SHA。仅隔离合成数据回退；真实开放流量后有新写入时仍遵守前文恢复限制。

## Target-host 实物与尚未关闭的门槛

`target-host-release.mjs stage|activate|rollback release-plan.json` 已提供真实文件/服务管理命令。stage只接ready计划及hash绑定归档/单位文件，拒绝归档越界/链接，记录解包manifest；activate再次核对计划和staged bytes、打开已指定维护命令、依顺序停止两服务、复制全state并核hash/mode、备份原drop-in存在性，写入新版配置并daemon-reload/start/check。启动或检查失败恢复state与原drop-in（包括原先不存在的情况），再启动旧服务并执行previous业务checks。维护持续开启，脚本不自动开放生产流量。备份失败在未写units时重启原服务并保留维护状态。

两份 `.conf.example` 只针对实际huijian.service/unseen-operable.service的drop-in，保留原unit其他配置，不替换成另一套book deployment unit。最终填入完整SHA并对渲染后文件hash绑定；不得直接安装带REQUIRED占位符的模板。当前 `.task/unseen-app/dual-release-evidence/release-plan.json` ready=false，绑定只读actual-prod-app完整archive identifier而非假定861/git SHA，候选SHA、维护命令、Linux依赖与完整业务checks完成后才可变为ready。

本机Darwin；Docker CLI存在，但daemon查询500，后续10秒查询超时，证据linux-runtime-check.json。target-host脚本文件行为已有模拟service manager的failed-start/post-check、原drop-in存在/不存在四项回归；不等于Linux/systemd真实启动证据。本地v2两进程HTTP也不替代Linux。独立Linux staging与真实目标依赖尚未验，R2不能标为生产可执行验收通过。

## 完整业务副本恢复（补充 R3，仍不是目标 Linux 验收）

2026-09-05 canonical agent短停4643并确认无listener，生成 `/tmp/unseen-private-consistent-snapshot-20260905-0309`，随后恢复原服务。该600/700保护副本包含两个SQLite、媒体/artifacts、原keyset、本地worker token与配置。本次仅复制到独立目录，未停/改原4643，没有向生产迁移。

`.task/unseen-app/restore-full-business-fixture.mjs` 已在独立端口启动精确backend4d941034b376aeb890d023bacbe30ca90f3e67c3和App f7d2f0d00a226a3074309b691c68473644802e0a，两服务经App代理完成原fixture账号登录、3份私有文档解密读取、授权Book第3版12页PDF和私有媒体读取；停止两服务后完整备份canonical及App状态，注入损坏，保留失败目录，再成套恢复并重新启动两服务重复业务读取。

恢复前后私有文档hash全部一致；PDF 937177 bytes，SHA256 ac27f68bd832283f67ae6268f968c9f9abba7e484f6766ef16c77ed1972d224f；媒体11412 bytes，hash一致。Book mounted、privateAiWorker和renderWorker开启；仅验证已有产物/授权数据，未提交新worker任务，不能称真实provider执行通过。App unknown World任务与剩余额度4均保留。业务收据为`dual-release-evidence/full-business-restore-01/business-receipt.json`。

此项是完整本地业务fixture的同pair备份恢复，不是旧生产8d schema的全业务降级，也不是target-host脚本在Linux/systemd中的执行。18→19迁移/旧pair恢复由v2合成证据独立证明，不能把两份证据合并成“完整旧生产恢复通过”。真实生产R3仍需在维护窗口或经批准的一致全量状态副本上验证身份/旧key/授权/Book/App数据，并运行目标Linux脚本。

目标计划另已加入现场确认的`/var/lib/unseen/operable/evidence`；canonical默认Book DB在dataRoot/book-lab.sqlite，媒体/artifacts应随实际配置对应持久根一起备份。显式Book配置覆盖、运行环境文件、secret提供位置仍需受保护清点，只记录路径/备份标识，不在报告输出值。第二服务stop失败会尝试重启原pair并验证previous checks，保留maintenance；失败的部分stop列表写独立记录。state备份/恢复核对hash、mode、uid/gid，恢复前复核备份inventory，避免损坏备份被无条件复制。

## R4：候选损坏不阻断可信回滚

`activate`仍验证candidate的staged文件hash；`rollback`不读取candidate文件作为前置条件。成功激活之后candidate代码损坏或丢失时，回滚仍可从可信旧代码目录、原unit及完整state备份恢复。

真实有制品的计划现在必须含`previousArtifacts:[{target:绝对旧制品目录,files:{相对路径:SHA256}}]`。该清单在stage时核对并进入冻结staged-plan；activate和rollback都再核对旧目录。`files`应由已审查的实际旧制品snapshot/manifest产生，不能只填server单文件hash或用未经验证的git标签替代。旧目录保留且不受候选安装覆盖；符号链接/额外文件同样拒绝，须预先物化可复核的旧运行制品。此处校验的是原unit实际恢复后将引用的代码目录，不是候选目录。

原unit备份保存各自SHA256；units存在性元数据及state inventory的hash另存于受保护transaction/backup-receipt.json。回滚先验证冻结plan、旧制品、两份备份元数据hash、旧unit字节hash以及state hash/mode/uid/gid，再执行维护/停止/恢复，篡改在破坏现状态前拒绝。可信根是受保护的冻结计划、transaction收据与目标机权限；没有声称抵御同时改写全部信任根的root级攻击。

真实CLI文件回归包括：stage→activate成功→candidate损坏→再次activate拒绝→explicitrollback恢复旧unit/state，以及candidate损坏同时state备份、unit备份、存在性元数据、计划、旧制品各自损坏时均拒绝恢复。服务管理器仍明确为测试替身，不将此R4回归当作独立Linux/systemd验收。
