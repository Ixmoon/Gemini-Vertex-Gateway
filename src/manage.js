document.addEventListener('DOMContentLoaded', () => {
	// --- 全局状态与元素引用 ---
	const API_BASE_URL = '/api/manage';
	let adminPassword = null;
	const dom = {
		messageArea: document.getElementById('message-area'),
		loginSection: document.getElementById('login-section'),
		managementSection: document.getElementById('management-section'),
		loginPasswordInput: document.getElementById('login-password'),
		loginButton: document.getElementById('login-button'),
		logoutButton: document.getElementById('logout-button'),
		get(id) {
			if (!this[`_${id}`]) {
                this[`_${id}`] = document.getElementById(id);
                if (!this[`_${id}`]) { // Basic guard
                    console.error(`DOM Element ${id} not found!`);
                    // return a mock element to prevent further errors in simple cases
                    return { value: '', textContent: '', classList: { add: ()=>{}, remove: ()=>{} }, onclick: null, addEventListener: ()=>{} };
                }
            }
			return this[`_${id}`];
		}
	};

	// --- UI & API 工具函数 ---
	function showMessage(message, type = 'success') {
		dom.messageArea.textContent = message;
		dom.messageArea.className = type; // success or error
        if (dom.messageArea.timeoutId) clearTimeout(dom.messageArea.timeoutId);
		dom.messageArea.timeoutId = setTimeout(() => {
            dom.messageArea.className = ''; // Clear class to hide
            dom.messageArea.textContent = '';
        }, 5000);
	}

	async function apiRequest(endpoint, method = 'GET', body = null) {
		const headers = { 'Content-Type': 'application/json' };
		if (endpoint !== '/login' && adminPassword) {
			headers['X-Admin-Password'] = adminPassword;
		}

		try {
			const response = await fetch(`${API_BASE_URL}${endpoint}`, {
				method,
				headers,
				body: body ? JSON.stringify(body) : null
			});
			const data = await response.json().catch(() => ({ error: `Failed to parse JSON from ${method} ${endpoint}` }));
			if (!response.ok) {
				throw new Error(data.error || `HTTP ${response.status} on ${method} ${endpoint}`);
			}
			return data;
		} catch (err) {
			showMessage(`API Error: ${err.message}`, 'error');
			if (err.message.includes('Unauthorized') || err.message.includes('401')) {
				showLoginSection();
			}
			return null;
		}
	}
    
    function renderList(listElement, items, renderConfig) {
        listElement.innerHTML = '';
        if (!items || items.length === 0) {
            listElement.innerHTML = '<li>列表为空</li>';
            return;
        }
        items.forEach(item => {
            const li = document.createElement('li');
            const itemSpan = document.createElement('span');
            
            if (renderConfig.itemType === 'poolKey' && typeof item === 'string' && item.length > 8) {
                itemSpan.textContent = `${item.substring(0, 4)}...${item.substring(item.length - 4)}`;
                li.title = item;
            } else {
                itemSpan.textContent = String(item);
            }
            li.appendChild(itemSpan);

            if (renderConfig.removeSingleEndpoint && renderConfig.singleItemKeyName) {
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '删除';
                deleteBtn.onclick = async () => {
                    if (confirm(`确定要删除 "${itemSpan.textContent}" 吗?`)) {
                        const body = {};
                        body[renderConfig.singleItemKeyName] = item;
                        const result = await apiRequest(renderConfig.removeSingleEndpoint, 'DELETE', body);
                        if (result) {
                            showMessage(result.message || 'Item removed.', 'success');
                            if (renderConfig.loadDataFunc) renderConfig.loadDataFunc();
                        }
                    }
                };
                li.appendChild(deleteBtn);
            }
            listElement.appendChild(li);
        });
    }

	// --- 数据加载与保存逻辑 ---
    function setupListManagement(config) {
        const singleInput = dom.get(`input-${config.idPrefix}-single`);
        const addSingleBtn = dom.get(`button-${config.idPrefix}-add-single`);
        const list = dom.get(`list-${config.idPrefix}`);
        const textarea = dom.get(`textarea-${config.idPrefix}`); // For bulk edit
        const saveBulkBtn = dom.get(`button-${config.idPrefix}-save`); // For bulk edit
        const clearAllBtn = dom.get(`button-${config.idPrefix}-clear`); // For bulk edit

        const loadData = async () => {
            const data = await apiRequest(config.getEndpoint);
            const items = data?.[config.dataKey] || [];
            renderList(list, items, {
                itemType: config.itemType,
                removeSingleEndpoint: config.removeSingleEndpoint,
                singleItemKeyName: config.singleItemKeyName,
                loadDataFunc: loadData
            });
            if (textarea) {
                textarea.value = JSON.stringify(items, null, 2);
            }
        };

        if (addSingleBtn && singleInput && config.addSingleEndpoint && config.singleItemKeyName) {
            addSingleBtn.onclick = async () => {
                const value = singleInput.value.trim();
                if (!value) return showMessage('Input cannot be empty.', 'error');
                const body = {};
                body[config.singleItemKeyName] = value;
                const result = await apiRequest(config.addSingleEndpoint, 'POST', body);
                if (result) {
                    showMessage(result.message || 'Item added.', 'success');
                    singleInput.value = '';
                    loadData();
                }
            };
        }

        if (saveBulkBtn && textarea && config.saveEndpoint) { 
            saveBulkBtn.onclick = async () => {
                try {
                    const items = JSON.parse(textarea.value);
                    if (!Array.isArray(items)) throw new Error("Input must be a JSON array.");
                    // For bulk save, the backend expects the data under config.dataKey
                    const body = {};
                    body[config.dataKey] = items; 
                    const result = await apiRequest(config.saveEndpoint, 'POST', body);
                    if (result) {
                        showMessage(result.message || 'List saved.', 'success');
                        loadData(); 
                    }
                } catch (e) {
                    showMessage(`Save failed: ${e.message}`, 'error');
                }
            };
        }

        if (clearAllBtn && config.clearEndpoint) {
            clearAllBtn.onclick = async () => {
                if (confirm(`确定要清空所有 ${config.name} 吗?`)) {
                    const result = await apiRequest(config.clearEndpoint, 'DELETE');
                    if (result) {
                        showMessage(result.message || 'List cleared.', 'success');
                        loadData();
                    }
                }
            };
        }

        loadData();
        return loadData; // Return for potential chaining or direct call
    }

	// --- 初始化与事件绑定 ---
	function showLoginSection() {
		adminPassword = null;
		dom.loginSection.classList.remove('hidden');
		dom.managementSection.classList.add('hidden');
        dom.loginPasswordInput.value = '';
        dom.loginPasswordInput.focus();
	}

	function showManagementSection() {
		dom.loginSection.classList.add('hidden');
		dom.managementSection.classList.remove('hidden');
		loadAllData();
	}

	// --- 特定配置的加载器 ---
	async function loadFallbackKey() {
		const data = await apiRequest('/fallback-key');
		const keyInput = dom.get('input-fallback-key');
        const currentDisplay = dom.get('current-fallback-key');
        if (data) {
            keyInput.value = data.key || '';
            if (data.key && data.key.length > 8) {
                currentDisplay.textContent = `${data.key.substring(0,4)}...${data.key.slice(-4)}`;
                currentDisplay.title = data.key;
            } else if (data.key) {
                currentDisplay.textContent = data.key;
                currentDisplay.removeAttribute('title');
            } else {
                currentDisplay.textContent = '未设置';
                currentDisplay.removeAttribute('title');
            }
        } else {
            keyInput.value = '';
            currentDisplay.textContent = '加载失败';
        }
	}
	dom.get('button-fallback-key-save').onclick = async () => {
		const key = dom.get('input-fallback-key').value.trim() || null; // Send null if empty to clear
		const result = await apiRequest('/fallback-key', 'POST', { key });
		if (result) { showMessage(result.message, 'success'); loadFallbackKey(); }
	};

	async function loadGcpSettings() {
		const data = await apiRequest('/gcp-settings');
		if (data) {
			dom.get('textarea-gcp-credentials').value = data.credentials || '';
			dom.get('input-gcp-location').value = data.location || 'global';
			dom.get('current-gcp-location').textContent = data.location || 'global';
			dom.get('current-gcp-credentials-status').textContent = data.credentials ? '已设置' : '未设置或为空';
            dom.get('current-gcp-credentials-status').style.color = data.credentials ? 'green' : '';
		} else {
            dom.get('current-gcp-credentials-status').textContent = '加载失败';
            dom.get('current-gcp-credentials-status').style.color = 'red';
        }
	}
	dom.get('button-gcp-settings-save').onclick = async () => {
		const credentials = dom.get('textarea-gcp-credentials').value.trim() || null; // Send null to clear
		const location = dom.get('input-gcp-location').value.trim() || 'global';
		const result = await apiRequest('/gcp-settings', 'POST', { credentials, location });
		if (result) { showMessage(result.message, 'success'); loadGcpSettings(); }
	};

	async function loadApiRetryLimit() {
		const data = await apiRequest('/retry-limit');
        const inputEl = dom.get('input-api-retry-limit');
        const currentEl = dom.get('current-api-retry-limit');
		if (data && typeof data.limit === 'number') {
			inputEl.value = data.limit;
			currentEl.textContent = data.limit;
		} else {
            inputEl.value = '3'; // Default placeholder
            currentEl.textContent = '加载失败';
        }
	}
	dom.get('button-api-retry-limit-save').onclick = async () => {
		const limit = parseInt(dom.get('input-api-retry-limit').value, 10);
		if (isNaN(limit) || limit < 1) return showMessage('Retry limit must be a positive integer.', 'error');
		const result = await apiRequest('/retry-limit', 'POST', { limit });
		if (result) { showMessage(result.message, 'success'); loadApiRetryLimit(); }
	};
	
	async function loadApiMappings() {
		const textarea = dom.get('textarea-api-mappings');
		const data = await apiRequest('/api-mappings');
		textarea.value = (data && data.mappings && typeof data.mappings === 'object') ? JSON.stringify(data.mappings, null, 2) : '{}';
	}
	dom.get('button-api-mappings-save').onclick = async () => {
		const textarea = dom.get('textarea-api-mappings');
		try {
			const mappings = JSON.parse(textarea.value.trim() || '{}'); // Default to empty object if textarea is empty
			if (typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error("Input must be a JSON object.");
			if (mappings['/gemini'] || mappings['/vertex']) throw new Error("Cannot set reserved paths: /gemini, /vertex via custom mappings.");
            // Basic validation (can be enhanced)
            for(const prefix in mappings) {
                if (!prefix.startsWith('/')) throw new Error(`Prefix "${prefix}" must start with '/'.`);
                try { new URL(mappings[prefix]); } catch { throw new Error(`URL for "${prefix}" is invalid: ${mappings[prefix]}`); }
            }
			const result = await apiRequest('/api-mappings', 'POST', { mappings });
			if (result) { showMessage(result.message, 'success'); loadApiMappings(); }
		} catch (e) {
			showMessage(`Save API Mappings failed: ${e.message}`, 'error');
		}
	};
    
	const loadAllData = () => Promise.all([
        setupListManagement({
            idPrefix: 'trigger-keys', name: '触发密钥', itemType: 'triggerKey', dataKey: 'keys',
            getEndpoint: '/trigger-keys', 
            saveEndpoint: '/trigger-keys', // For bulk save
            addSingleEndpoint: '/trigger-keys/add',
            removeSingleEndpoint: '/trigger-keys/remove',
            clearEndpoint: '/trigger-keys/all',
            singleItemKeyName: 'key'
        }),
        setupListManagement({
            idPrefix: 'pool-keys', name: '池密钥', itemType: 'poolKey', dataKey: 'keys',
            getEndpoint: '/pool-keys',
            saveEndpoint: '/pool-keys', // For bulk save
            addSingleEndpoint: '/pool-keys/add',
            removeSingleEndpoint: '/pool-keys/remove',
            clearEndpoint: '/pool-keys/all',
            singleItemKeyName: 'key'
        }),
        setupListManagement({
            idPrefix: 'fallback-models', name: '回退模型', itemType: 'fallbackModel', dataKey: 'models',
            getEndpoint: '/fallback-models',
            saveEndpoint: '/fallback-models', // For bulk save
            addSingleEndpoint: '/fallback-models/add',
            removeSingleEndpoint: '/fallback-models/remove',
            clearEndpoint: '/fallback-models/all',
            singleItemKeyName: 'model'
        }),
        loadFallbackKey(),
        loadGcpSettings(),
        loadApiRetryLimit(),
        loadApiMappings()
	]).catch(err => {
        console.error("Error loading initial data:", err);
        showMessage("Failed to load some initial data. Check console.", "error");
    });

	dom.loginButton.onclick = async () => {
		const password = dom.loginPasswordInput.value;
		if (!password) return showMessage('Password is required.', 'error');
		const result = await apiRequest('/login', 'POST', { password });
		if (result?.success) {
			adminPassword = password;
			showMessage(result.message || 'Login successful!', 'success');
			showManagementSection();
		} else if (result && result.error) {
            // Error message already shown by apiRequest
            dom.loginPasswordInput.focus();
        } else {
            showMessage("Login failed. Please check password or console.", "error");
            dom.loginPasswordInput.focus();
        }
	};

    dom.loginPasswordInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevent form submission if it were a form
            dom.loginButton.click();
        }
    });

	dom.logoutButton.onclick = () => {
		showMessage('Logged out.', 'success');
        adminPassword = null; // Clear sensitive data
		showLoginSection();
	};

	showLoginSection();
});