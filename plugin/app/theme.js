// Applies the saved theme before the page paints, so there is no flash of the wrong colours.
try {
    var savedTheme = localStorage.getItem('korrektor.theme');
    var savedAccent = localStorage.getItem('korrektor.accent');
    if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
    if (savedAccent && savedAccent !== 'amber') document.documentElement.dataset.accent = savedAccent;
} catch (e) {
    // storage off: the system theme is used
}
