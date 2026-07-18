# Twitter Timeline Collector

最小闭环浏览器扩展，用于在当前 X 账号页内拦截页面已经发出的 `/i/api/graphql/.../UserTweets` 响应，自动滚动页面继续触发加载，并在插件 side panel 内直接展示符合条件的推文结果。

## 手动安装

1. 打开 Chrome 或 Edge 的扩展管理页
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择目录 `src/twitter-timeline/plugins/timeline-collector/`

## 当前主链路

1. 打开一个 X 账号页，例如 `https://x.com/karpathy`
2. 点击扩展图标，打开 side panel
3. 可选填写 `sinceTime` 和 `maxTweets`
4. 点击“测试抓取”
5. 插件会刷新当前页面，并在页面重新就绪后自动开始抓取
6. 抓取过程中插件会自动滚动页面，以触发更多 `UserTweets`
7. side panel 会自动刷新状态，并完整展示最终结果集

## 结果口径

- 如果填写了 `sinceTime`，side panel 只展示满足 `sinceTime` 和 `maxTweets` 条件的最终结果集
- 如果没有填写 `sinceTime`，side panel 展示本次抓取到的全部结果，直到命中 `maxTweets` 或滚动停止条件
- 置顶推文仍会保留在结果集中

## 说明

- 插件优先拦截页面已有的 `UserTweets` 响应，不主动请求 X GraphQL API
- 为了降低漏数风险，抓取过程中也会使用当前页面 DOM 作为兜底结果来源
- side panel 中仍保留诊断信息区域，便于排查刷新、注入、滚动和后台状态问题
