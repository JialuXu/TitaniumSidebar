// service worker：点击工具栏图标即打开侧边栏。
// 顶层调用（service worker 每次唤醒都会执行，幂等），除此之外不做任何事。
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('设置侧边栏行为失败：', err));
