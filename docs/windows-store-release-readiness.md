# Windows Store EXE 发布前自测

本指南用于最终提交 Microsoft Store 的 Lily Workbench x64、NSIS、版本化 EXE，
例如 `Lily Workbench-0.2.0-x64.exe`。这里的脚本只验证本地安装包：它们不会签名、
上传或发布，也不会删除聊天、工作区或其他用户数据。runner 只会调用本次测试安装
所登记的正常卸载程序，并盘点卸载后的数据残留。

## Microsoft direct EXE/MSI 提交要求

把 direct EXE/MSI 提交到 Partner Center 前，至少逐项确认：

- 使用带版本号、可通过 HTTPS 直接下载的完整离线 installer；安装不能依赖联网补包。
- 提交后不要替换该 URL 对应的 binary。新 binary 使用新版本和新 URL，保留已提交
  URL 的字节不变。
- installer 本身以及安装目录内的每个 PE 都具有有效 Authenticode 签名。
- Partner Center 的静默安装参数填写为 `/S /currentuser`；安装必须以当前用户范围完成，
  全程无安装 UI，且在时限内以退出码 0 结束。
- 安装后只出现一条正确的“应用和功能”(ARP) 记录；`DisplayName`、`Publisher`、
  `DisplayVersion`、`InstallLocation`、`UninstallString` 和 `QuietUninstallString`
  等 metadata 完整，版本和 publisher 与提交内容一致。
- 断网启动不会崩溃：主窗口和 packaged renderer 能就绪，Windows Application event
  log 没有 Lily 崩溃记录，并可正常关闭。
- `QuietUninstallString` 支持大小写敏感的 `/S` 静默卸载；卸载无 UI、退出码为 0，
  ARP、安装目录和快捷方式消失，并对用户数据 residue 给出明确结论。

微软原始要求和手工验证入口：

- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process

这些 URL、版本不可变性和 Partner Center 字段仍需人工核对；本地脚本不会替代提交后台
检查。

## 测试环境

准备两个相互独立、可回滚到干净快照的环境：

1. 启用了 Windows Sandbox 的 Windows 11 Pro、Enterprise 或 Education，用于干净、
   完全离线的安装/启动/卸载演练。Sandbox 默认以管理员身份运行，因此这里只能证明
   干净环境和离线生命周期，不能证明标准用户路径。
2. 真实 Windows 的干净 VM，以从未安装过 Lily Workbench 的标准用户登录，从非提升
   PowerShell 直接运行 smoke runner。这是最终必须通过的 per-user 安装环境。

Windows 11 Home 没有可依赖的 Windows Sandbox 时，使用 VM；需要 Sandbox 的 guest
应使用支持该功能的 Windows 11 版本。不要在已经安装 Lily Workbench 的账号或 VM
快照上运行。runner 会在安装前检查 ARP：发现已有安装就拒绝继续，并且不会卸载预存安装；
只有越过干净环境门禁、确实开始了本次安装后，它才拥有调用正常卸载程序的清理权限。

每轮先恢复干净快照，将仓库和待测 EXE 放入 VM，然后确认 PowerShell 当前 token 不是
提升后的管理员 token。不要把 Windows Sandbox 的管理员 warning 当作标准用户验证。

## 证书到位前的 rehearsal

先在真实 Windows 的干净标准用户 VM 中做 direct smoke。以下命令在仓库根目录的
非提升 PowerShell 中运行；把示例 installer 路径替换为本轮实际文件：

```powershell
Set-Location C:\src\lily-workbench
$installer = (Resolve-Path -LiteralPath "C:\artifacts\Lily Workbench-0.2.0-x64.exe" -ErrorAction Stop).ProviderPath
$outputDirectory = Join-Path $PWD.Path (".lily-work\windows-store-readiness\direct-rehearsal-{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), [Guid]::NewGuid().ToString("N"))

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\smoke-windows-store-installer.ps1 `
  -Installer $installer `
  -OutputDirectory $outputDirectory `
  -AllowUserDataRemnants
if ($LASTEXITCODE -ne 0) { throw "Standard-user rehearsal failed; inspect $outputDirectory" }
```

`-AllowUserDataRemnants` 只把已盘点的用户数据 residue 从 `fail` 降为 `warning`；它不会
删除 residue，也不会放宽安装、启动、ARP、卸载或进程清理失败。证书尚未到位时，unsigned
installer 和 unsigned installed PE 也会是 `warning`。这些 warning 是 rehearsal 的已知
缺口，不等于最终门禁通过。

## Windows Sandbox 离线 rehearsal

在启用了 Windows Sandbox 的 Windows 11 Pro、Enterprise 或 Education 主机上，从仓库
根目录运行：

```powershell
Set-Location C:\src\lily-workbench
$installer = (Resolve-Path -LiteralPath "C:\artifacts\Lily Workbench-0.2.0-x64.exe" -ErrorAction Stop).ProviderPath

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\start-windows-store-sandbox.ps1 `
  -Installer $installer `
  -AllowUserDataRemnants
if ($LASTEXITCODE -ne 0) { throw "Offline Sandbox rehearsal failed" }
```

launcher 会为每次运行新建
`.lily-work\windows-store-readiness\sandbox-<时间戳>-<唯一 GUID 后缀>`，只把这个唯一
stage 映射到 Sandbox 的 `C:\LilyStoreReadiness`。网络和剪贴板映射被禁用；installer、
runner、配置与输出都局限在该 stage。Sandbox 关闭后，报告和 transcript 仍保留在 host
stage，launcher 不会删除它们。Sandbox 的 administrator warning 是预期证据，但绝不
替代上一节的标准用户 direct run。

## 最终签名门禁

签名后冻结最终 EXE。以下预检必须在用于发起门禁的 Windows 环境中重新执行，不能手填
publisher 或从另一个 binary 推断版本：

```powershell
Set-Location C:\src\lily-workbench
$installer = (Resolve-Path -LiteralPath "C:\artifacts\Lily Workbench-0.2.0-x64.exe" -ErrorAction Stop).ProviderPath
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $signature.SignerCertificate) {
  throw "Installer Authenticode signature or signer certificate is not valid."
}

$fileName = [System.IO.Path]::GetFileName($installer)
if (-not ($fileName -cmatch '^Lily Workbench-(?<version>\d+\.\d+\.\d+)-x64\.exe$')) {
  throw "Installer filename must be Lily Workbench-<major.minor.patch>-x64.exe."
}
$publisher = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
if ([string]::IsNullOrWhiteSpace($publisher)) { throw "Signer certificate has no SimpleName publisher." }
$version = $Matches.version
$sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
"installer=$installer`nversion=$version`npublisher=$publisher`nsha256=$sha256"
```

先在 Sandbox host 的同一个 PowerShell 会话运行严格离线门禁：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\start-windows-store-sandbox.ps1 `
  -Installer $installer `
  -RequireSignature `
  -ExpectedPublisher $publisher `
  -ExpectedVersion $version
if ($LASTEXITCODE -ne 0) { throw "Signed offline Sandbox gate failed" }
```

然后恢复真实 Windows 标准用户 VM 的干净快照，复制同一个 EXE 和仓库，在非提升
PowerShell 中重新运行上面的 resolve/signature/filename/publisher/version 预检，并执行：

```powershell
$outputDirectory = Join-Path $PWD.Path (".lily-work\windows-store-readiness\signed-standard-user-{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), [Guid]::NewGuid().ToString("N"))

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\smoke-windows-store-installer.ps1 `
  -Installer $installer `
  -OutputDirectory $outputDirectory `
  -RequireSignature `
  -ExpectedPublisher $publisher `
  -ExpectedVersion $version
if ($LASTEXITCODE -ne 0) { throw "Signed standard-user gate failed; inspect $outputDirectory" }
```

这两条最终命令故意不传 `-AllowUserDataRemnants`。任何已知聊天、工作区或用户数据 residue
都会使严格门禁 `fail`，但 runner 只记录路径，不会删除它们。若产品决定改变卸载数据策略，
必须另行评审数据保留、迁移和用户授权，不能为让本门禁变绿而在 runner 中加入删除逻辑。

## 报告与判读

每次 direct run 的 `-OutputDirectory`，以及 Sandbox stage 下的 `results`，至少应保留：

- `readiness-report.json`：机器、installer、checks 和证据索引的结构化 JSON。
- `readiness-summary.md`：供人工快速检查的 PASS/FAIL 摘要。
- `readiness-transcript.log`：完整 PowerShell transcript。
- `signature-inventory.json`：安装目录内全部 MZ/PE 的 Authenticode inventory。
- `registry-before.json`、`registry-installed.json`、`registry-after.json`：安装前、安装后、
  卸载清理后的真实 ARP 快照。
- `user-data-residue.json`：只读盘点到的聊天、工作区及其他已知用户数据 residue。
- `startup-event-log.json`：本轮启动窗口内的 Windows Application crash event 证据。
- `chromium.log`：packaged renderer 启动日志。
- `readiness-exit-code.txt`：runner 完成 sentinel；Sandbox launcher 以它为权威退出码。

`fail` 会令 runner 退出 1。`warning` 不会单独令整体失败，它用于明确标识 unsigned rehearsal、
Sandbox 管理员 token 或经 `-AllowUserDataRemnants` 授权的 residue 等已知限制；最终审核仍应
逐条解释。`not_applicable` 表示该检查对当前 artifact 不适用，既不是失败，也不是认证通过。
不要只保存 summary；将 JSON、transcript、各 inventory、日志、sentinel 和最终 EXE 的
SHA-256 一起归档。

## Windows App Certification Kit 的适用性

当前 Windows App Certification Kit (WACK) CLI 接受 package full name，或对 AppX/MSIX
package 运行。Lily 当前交付的是 raw/unpackaged NSIS EXE，因此 WACK 对本 artifact **不适用**，
runner 会诚实记录 `certification.wack = not_applicable`，不会伪造认证结果。

旧资料中的 `-apptype desktop -setuppath` 是 Windows 8.1 时期的历史接口，不能把它称为
2026 年的 Store 认证。当前 raw EXE 应按微软 direct MSI/EXE 要求做 manual package
validation，并以本指南的真实 Windows 生命周期证据补齐提交前检查。将来若 Lily 发布
MSIX，再针对那个 packaged artifact 接入当前 WACK 流程。

## 完成标准

只有同一个已签名、版本化 x64 EXE（相同 SHA-256）在以下两处都以严格模式退出 0，才可
进入 Partner Center：

1. Windows Sandbox 中的离线生命周期门禁；
2. 真实 Windows 干净标准用户 VM 中的 direct 生命周期和签名门禁。

两次都不得传 `-AllowUserDataRemnants`，并要保留完整报告。macOS 上用 Node 24 运行的静态
contract test 只能证明脚本和本指南没有丢失关键约束，不能证明 Windows 安装/启动/卸载
生命周期通过，也不能证明 Microsoft 已接受或认证该 EXE。本仓库中的文档和测试不声称
已经在 Windows 跑过或已经通过 Microsoft 认证。
