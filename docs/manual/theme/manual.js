// Adds an "albedo" link to the landing page at the end of the menu bar's
// left buttons.
(function () {
    'use strict';
    function addHomeLink() {
        if (document.querySelector('.albedo-home')) return;
        var left = document.querySelector('#mdbook-menu-bar .left-buttons') || document.querySelector('.left-buttons');
        if (!left) return;
        var a = document.createElement('a');
        a.className = 'albedo-home';
        a.href = '../';
        a.textContent = 'albedo';
        a.title = 'albedo home page';
        left.appendChild(a);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addHomeLink);
    else addHomeLink();
})();
