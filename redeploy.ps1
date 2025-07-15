# redeploy.ps1
#
# 这个脚本用于将本地的 secrets.config.json 文件内容更新到 GitHub Actions 的机密中，
# 然后立即触发一次新的部署。

# 步骤 1: 将本地 secrets.config.json 的内容设置为 GitHub 仓库的机密
# 注意：如果 gh 命令未找到，请确保 GitHub CLI 的路径已添加到您的 PATH 环境变量中。
Write-Host "正在更新机密 SECRETS_CONFIG_JSON..."
Get-Content secrets.config.json | gh secret set SECRETS_CONFIG_JSON
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误：更新机密失败。请检查您是否已通过 'gh auth login' 登录，以及 secrets.config.json 文件是否存在。"
    exit 1
}
Write-Host "机密更新成功。"
Write-Host ""

# 步骤 2: 触发部署工作流
# 注意：这将运行名为 deploy.yml 的工作流。
Write-Host "正在触发部署工作流 (deploy.yml)..."
gh workflow run deploy.yml
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误：触发工作流失败。"
    exit 1
}
Write-Host "成功触发部署。请访问您的 GitHub Actions 页面查看进度。"