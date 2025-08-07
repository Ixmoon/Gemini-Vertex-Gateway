document.addEventListener('DOMContentLoaded', () => {
    const loginView = document.getElementById('login-view');
    const dashboardView = document.getElementById('dashboard-view');
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password');
    const loginError = document.getElementById('login-error');
    const logoutBtn = document.getElementById('logout-btn');
    const keysTableBody = document.getElementById('keys-table-body');
    const addKeyForm = document.getElementById('add-key-form');
    const newKeyInput = document.getElementById('new-key-input');
    const dashboardMessage = document.getElementById('dashboard-message');

    // --- API 函数 ---
    const api = {
        async getLicenses() {
            const response = await fetch('/api/licenses');
            if (response.status === 401) {
                showLoginView();
                return null;
            }
            return response.json();
        },
        async addLicense(key) {
            const response = await fetch('/api/licenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            });
            return response.json();
        },
        async deleteLicense(key) {
            const response = await fetch(`/api/licenses?key=${encodeURIComponent(key)}`, {
                method: 'DELETE',
            });
            return response.json();
        }
    };

    // --- 视图切换 ---
    function showLoginView() {
        loginView.style.display = 'block';
        dashboardView.style.display = 'none';
    }

    function showDashboardView() {
        loginView.style.display = 'none';
        dashboardView.style.display = 'block';
        loadLicenses();
    }

    // --- 核心功能 ---
    async function loadLicenses() {
        const licenses = await api.getLicenses();
        if (!licenses) return;

        keysTableBody.innerHTML = '';
        if (licenses.length === 0) {
            keysTableBody.innerHTML = '<tr><td colspan="3" style="text-align: center;">暂无授权码</td></tr>';
            return;
        }

        licenses.forEach(license => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${license.key}</td>
                <td>${new Date(license.created_at).toLocaleString()}</td>
                <td><button class="delete-btn" data-key="${license.key}">删除</button></td>
            `;
            keysTableBody.appendChild(row);
        });
    }

    // --- 事件监听 ---
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        const password = passwordInput.value;

        const response = await fetch('/admin/login', {
            method: 'POST',
            body: new URLSearchParams({ password })
        });

        if (response.ok && response.redirected) {
            window.location.reload();
        } else {
            loginError.textContent = '密码错误，请重试。';
        }
    });

    logoutBtn.addEventListener('click', () => {
        window.location.href = '/admin/logout';
    });

    addKeyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newKey = newKeyInput.value.trim();
        if (!newKey) return;

        const result = await api.addLicense(newKey);
        if (result.success) {
            newKeyInput.value = '';
            dashboardMessage.textContent = `成功添加密钥: ${newKey}`;
            loadLicenses();
        } else {
            dashboardMessage.textContent = '添加失败，请重试。';
        }
        setTimeout(() => dashboardMessage.textContent = '', 3000);
    });

    keysTableBody.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-btn')) {
            const key = e.target.dataset.key;
            if (confirm(`您确定要删除密钥 "${key}" 吗？此操作不可撤销。`)) {
                const result = await api.deleteLicense(key);
                if (result.success) {
                    dashboardMessage.textContent = `成功删除密钥: ${key}`;
                    loadLicenses();
                } else {
                    dashboardMessage.textContent = '删除失败，请重试。';
                }
                setTimeout(() => dashboardMessage.textContent = '', 3000);
            }
        }
    });

    // --- 初始化 ---
    async function init() {
        // 尝试获取数据，如果成功（未被重定向到登录页），则显示后台
        const response = await fetch('/api/licenses');
        if (response.ok) {
            showDashboardView();
        } else {
            showLoginView();
        }
    }

    init();
});