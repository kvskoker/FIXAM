/**
 * Shared modal dialogs, replacing the browser's native alert()/confirm().
 *
 * Native dialogs block the thread and render in the operating system's chrome,
 * so they look nothing like the rest of the portal and cannot be styled for
 * dark mode. This draws one reusable modal with the same styles the other
 * dialogs use, and exposes it as:
 *
 *   showAlert(message, options)   -> Promise (OK button)
 *   showConfirm(message, options) -> Promise<boolean> (Cancel / Confirm)
 *
 * `showAlert` is safe to call without awaiting -- the message shows and the
 * calling code continues. `showConfirm` must be awaited; the caller branches on
 * its result.
 */
(function () {
    let overlay = null;

    function ensureOverlay() {
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.id = 'ui-dialog-modal';
        overlay.innerHTML = `
            <div class="modal-content" style="max-width: 440px;">
                <div class="modal-header" style="margin-bottom: 1rem;">
                    <h2 id="ui-dialog-title" style="font-size: 1.1rem; margin: 0;">Notice</h2>
                    <button class="action-btn" id="ui-dialog-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div id="ui-dialog-body" style="color: var(--admin-text); line-height: 1.5; white-space: pre-wrap;"></div>
                <div id="ui-dialog-actions" style="display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 1.5rem;"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    function open(o) {
        o.classList.add('active');
    }

    function close() {
        const o = ensureOverlay();
        o.classList.remove('active');
    }

    function button(label, className, onClick) {
        const el = document.createElement('button');
        el.className = className;
        el.textContent = label;
        el.addEventListener('click', onClick);
        return el;
    }

    function mount(message, options) {
        const o = ensureOverlay();
        document.getElementById('ui-dialog-title').textContent = options.title || 'Notice';
        document.getElementById('ui-dialog-body').textContent = message;
        const actions = document.getElementById('ui-dialog-actions');
        actions.innerHTML = '';
        return { o, actions, closeBtn: document.getElementById('ui-dialog-close') };
    }

    window.showAlert = function (message, options = {}) {
        const { o, actions, closeBtn } = mount(message, options);

        return new Promise((resolve) => {
            const done = () => { close(); resolve(); };
            closeBtn.addEventListener('click', done, { once: true });
            actions.appendChild(button(options.okText || 'OK', 'btn btn-primary', done));
            open(o);
        });
    };

    window.showConfirm = function (message, options = {}) {
        const { o, actions, closeBtn } = mount(message, options);

        return new Promise((resolve) => {
            const done = (result) => { close(); resolve(result); };

            closeBtn.addEventListener('click', () => done(false), { once: true });
            actions.appendChild(button(options.cancelText || 'Cancel', 'btn btn-secondary', () => done(false)));

            const confirmBtn = button(options.confirmText || 'Confirm', 'btn btn-primary', () => done(true));
            if (options.danger) confirmBtn.style.background = 'var(--admin-danger)';
            actions.appendChild(confirmBtn);

            open(o);
        });
    };
})();
