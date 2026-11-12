# YouTuBi

[English](README.en.md) · 简体中文

把 YouTube 评论和直播聊天变成随视频播放的弹幕的浏览器扩展（支持 Chrome / Edge）。

## 安装

1. 从 [Releases](https://github.com/yilong-musk/YouTuBi/releases) 下载最新的 `youtubi-*.zip` 并解压
2. 打开 `chrome://extensions/`（或 `edge://extensions/`），开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压后的目录
4. 打开 YouTube 视频页即可看到弹幕

## 使用

- 视频页点赞按钮旁可开关弹幕
- 弹幕左侧的发送按钮：暂停播放并弹出输入框，回车发布带时间戳的评论弹幕，Esc 或点击外部关闭并恢复播放
- 评论以「13:45 xxx」开头的弹幕会在该时间点出现，且不显示时间前缀
- 点击右上角扩展图标可调整范围、速度、字号、透明度、预加载数
- 广告播放时自动 16 倍速、静音并点击「跳过」，可在弹窗关闭
- 实验性去广告（默认关闭，需在弹窗开启）：只对经典贴片广告有效，服务端拼接广告无法去除，且可能随 YouTube 改版失效

## 隐私

- 只在 YouTube 页面运行，数据不发送到第三方服务器
- 只申请 `storage`、`declarativeNetRequest` 与 YouTube 站点访问权限；开启去广告时会拦截 YouTube 页面发往广告域名的请求，数据不发送到第三方服务器

## License

MIT