// Apply the saved theme before first paint so there is no light/dark flash.
(function () {
  try {
    var raw = localStorage.getItem('tidings.settings')
    var theme = raw ? (JSON.parse(raw).state || {}).theme : 'system'
    var dark =
      theme === 'dark' ||
      ((!theme || theme === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
  } catch (e) {}
})()
