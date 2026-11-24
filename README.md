# 每日热点（GitHub Pages 版）

抓公开榜单 → 分门别类 → 生成一个纯静态页面 → 由 GitHub Actions 每天北京时间 08:00 自动重新生成并发布。

数据源：微博热搜、知乎热榜、B站热门、百度热搜、Hacker News（境外 runner 上 GitHub Trending 也能抓）。

## 一次性配置

1. 新建仓库（建议 **Public**，Actions 不限分钟数）
2. 把本目录所有文件推到默认分支（`main`）
3. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**
4. 仓库 **Actions** 标签页，选 `daily-digest` → **Run workflow** 手动跑一次，确认成功
5. 地址：`https://<用户名>.github.io/<仓库名>/`

## 定时

`.github/workflows/daily.yml` 里 `cron: '0 0 * * *'` 是 UTC，等于北京时间 08:00。
GitHub 定时器在高峰期会延迟 5–20 分钟，属正常现象。

## 注意

- **60 天无提交**会停用定时任务：进 Actions 点一下 Enable 即可，或偶尔提交一次
- 公开仓库 60 天：`Settings → Actions → General` 里确认 workflow 权限没被收紧
- runner 在境外，微博/百度有时会返回空或风控页，脚本会跳过该源、其余照常出页
- 页面产物不提交进仓库，由 `upload-pages-artifact` 直接发布

## 本地预览

```bash
node digest.mjs       # 生成 dist/
npx serve dist        # 或任意静态服务器
```
