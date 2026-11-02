/* 数据中心顶部分享按钮：复用页面现有的分享处理与回退逻辑。 */
(() => {
  const headerButton = document.getElementById("dataShareHeaderBtn");
  const existingShareAction = document.getElementById("dataShareBtn");
  if (!headerButton || !existingShareAction) return;
  headerButton.addEventListener("click", () => existingShareAction.click());
})();
