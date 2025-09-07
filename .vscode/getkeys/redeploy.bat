@echo off
chcp 65001 > nul
REM redeploy.bat

echo 正在更新机密 SECRETS_CONFIG_JSON...
gh secret set SECRETS_CONFIG_JSON < secrets.config.json
if %errorlevel% neq 0 (
    echo 错误：更新机密失败。请检查您是否已通过 'gh auth login' 登录，以及 secrets.config.json 文件是否存在。
    goto :eof
)
echo 机密更新成功。
echo.

echo 正在触发部署工作流 (deploy.yml)...
gh workflow run deploy.yml
if %errorlevel% neq 0 (
    echo 错误：触发工作流失败。
    goto :eof
)
echo 成功触发部署。请访问您的 GitHub Actions 页面查看进度。
echo.
pause