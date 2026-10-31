[CmdletBinding()] param([string]$Distro = "Ubuntu-22.04")
$ErrorActionPreference = "Stop"
& wsl.exe -d $Distro -- bash /home/max/src/unseen-local-product/app/stop-local-product.sh
if ($LASTEXITCODE -ne 0) { throw "Stop command failed." }
