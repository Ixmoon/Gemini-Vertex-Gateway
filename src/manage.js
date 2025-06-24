document.addEventListener('DOMContentLoaded', () => {
	// --- Global State & Element Cache ---
	const API_BASE_URL = '/api/manage';
	let adminPassword = null;
	const dom = new Proxy({}, {
		get: (target, prop) => {
			if (!target[prop]) {
				target[prop] = document.getElementById(prop);
			}
			return target[prop];
		}
	});

	// --- UI & API Utilities ---
	function showMessage(message, type = 'success') {
		dom.messageArea.textContent = message;
		dom.messageArea.className = type; // Sets class to 'success' or 'error', which have `display: block`
		if (dom.messageArea.timeoutId) clearTimeout(dom.messageArea.timeoutId);
		dom.messageArea.timeoutId = setTimeout(() => {
			dom.messageArea.className = ''; // Hides the element by removing the class
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
			const data = await response.json().catch(() => ({
				success: false,
				error: `HTTP ${response.status} - Failed to parse JSON response.`
			}));

			if (!response.ok || !data.success) {
				throw new Error(data.error || `An unknown API error occurred.`);
			}
			return data;
		} catch (err) {
			showMessage(err.message, 'error');
			if (err.message.includes('Unauthorized')) {
				showLoginSection();
			}
			return null;
		}
	}

	// --- Generic Setup Functions ---

	/** Generic setup for a configuration section that uses a textarea for a JSON array */
	function setupJsonListSection(config) {
		const load = async () => {
			const data = await apiRequest(`/${config.path}`);
			if (data) {
				dom[config.textareaId].value = JSON.stringify(data[config.path] || [], null, 2);
				updateItemList(dom[config.listId], data[config.path] || []);
			}
		};

		dom[config.saveBtnId].onclick = async () => {
			try {
				const items = JSON.parse(dom[config.textareaId].value.trim() || '[]');
				if (!Array.isArray(items)) throw new Error("Input must be a JSON array.");

				const body = { [config.path]: items };
				const result = await apiRequest(`/${config.path}`, 'POST', body);
				if (result) {
					showMessage(result.message, 'success');
					load(); // Reload to confirm
				}
			} catch (e) {
				showMessage(`Save failed: ${e.message}`, 'error');
			}
		};

		dom[config.addBtnId].onclick = () => {
			const newItem = dom[config.inputId].value.trim();
			if (!newItem) return;
			try {
				const items = JSON.parse(dom[config.textareaId].value.trim() || '[]');
				if (!items.includes(newItem)) {
					items.push(newItem);
					dom[config.textareaId].value = JSON.stringify(items, null, 2);
					updateItemList(dom[config.listId], items); // Update preview
				}
				dom[config.inputId].value = '';
			} catch (e) {
				showMessage(`Could not add item: ${e.message}`, 'error');
			}
		};
        
        dom[config.clearBtnId].onclick = async () => {
            if (confirm(`Are you sure you want to clear all ${config.name}?`)) {
                const result = await apiRequest(`/${config.path}/all`, 'DELETE');
                if (result) {
                    showMessage(result.message, 'success');
                    load();
                }
            }
        };

		load();
	}

	function updateItemList(listElement, items) {
		listElement.innerHTML = '';
		if (!items || items.length === 0) {
			listElement.innerHTML = '<li>列表为空</li>';
			return;
		}
		items.forEach(item => {
			const li = document.createElement('li');
			const span = document.createElement('span');
			// Obfuscate long keys
			if (typeof item === 'string' && item.length > 20 && item.includes('AIza')) {
				span.textContent = `${item.substring(0, 4)}...${item.slice(-4)}`;
				li.title = item;
			} else {
				span.textContent = item;
			}
			li.appendChild(span);
			listElement.appendChild(li);
		});
	}

	// --- Load All Data ---
	function loadAllData() {
		// Setup for Trigger Keys
		setupJsonListSection({
			path: 'trigger-keys', name: 'Trigger Keys',
			textareaId: 'textarea-trigger-keys', listId: 'list-trigger-keys',
			saveBtnId: 'button-trigger-keys-save', addBtnId: 'button-trigger-keys-add-single',
			inputId: 'input-trigger-keys-single', clearBtnId: 'button-trigger-keys-clear'
		});

		// Setup for Pool Keys
		setupJsonListSection({
			path: 'pool-keys', name: 'Pool Keys',
			textareaId: 'textarea-pool-keys', listId: 'list-pool-keys',
			saveBtnId: 'button-pool-keys-save', addBtnId: 'button-pool-keys-add-single',
			inputId: 'input-pool-keys-single', clearBtnId: 'button-pool-keys-clear'
		});

		// Setup for Fallback Models
		setupJsonListSection({
			path: 'fallback-models', name: 'Fallback Models',
			textareaId: 'textarea-fallback-models', listId: 'list-fallback-models',
			saveBtnId: 'button-fallback-models-save', addBtnId: 'button-fallback-models-add-single',
			inputId: 'input-fallback-models-single', clearBtnId: 'button-fallback-models-clear'
		});

		// Load Fallback Key
		const loadFallbackKey = async () => {
			const data = await apiRequest('/fallback-key');
			if (data) {
				const key = data.key || '';
				dom['input-fallback-key'].value = key;
				if (key && key.length > 8) {
					dom['current-fallback-key'].textContent = `${key.substring(0, 4)}...${key.slice(-4)}`;
				} else {
					dom['current-fallback-key'].textContent = key || '未设置';
				}
			}
		};
		dom['button-fallback-key-save'].onclick = async () => {
			const key = dom['input-fallback-key'].value.trim() || null;
			const result = await apiRequest('/fallback-key', 'POST', { key });
			if (result) {
				showMessage(result.message, 'success');
				loadFallbackKey();
			}
		};
		loadFallbackKey();

		// Load GCP Settings
		const loadGcpSettings = async () => {
			const data = await apiRequest('/gcp-settings');
			if (data) {
				dom['textarea-gcp-credentials'].value = data.credentials || '';
				dom['input-gcp-location'].value = data.location || 'global';
				dom['current-gcp-location'].textContent = data.location || 'global';
				dom['current-gcp-credentials-status'].textContent = data.credentials ? '已设置' : '未设置';
			}
		};
		dom['button-gcp-settings-save'].onclick = async () => {
			const credentials = dom['textarea-gcp-credentials'].value.trim() || null;
			const location = dom['input-gcp-location'].value.trim() || 'global';
			const result = await apiRequest('/gcp-settings', 'POST', { credentials, location });
			if (result) {
				showMessage(result.message, 'success');
				loadGcpSettings();
			}
		};
		loadGcpSettings();
        
		// Load API Retry Limit
		const loadApiRetryLimit = async () => {
			const data = await apiRequest('/retry-limit');
			if (data) {
				dom['input-api-retry-limit'].value = data.limit;
				dom['current-api-retry-limit'].textContent = data.limit;
			}
		};
		dom['button-api-retry-limit-save'].onclick = async () => {
			const limit = parseInt(dom['input-api-retry-limit'].value, 10);
			if (isNaN(limit) || limit < 1) return showMessage('Retry limit must be a positive integer.', 'error');
			const result = await apiRequest('/retry-limit', 'POST', { limit });
			if (result) {
				showMessage(result.message, 'success');
				loadApiRetryLimit();
			}
		};
		loadApiRetryLimit();

		// Load API Mappings
		const loadApiMappings = async () => {
			const data = await apiRequest('/api-mappings');
			if (data) {
				dom['textarea-api-mappings'].value = JSON.stringify(data.mappings || {}, null, 2);
			}
		};
		dom['button-api-mappings-save'].onclick = async () => {
			try {
				const mappings = JSON.parse(dom['textarea-api-mappings'].value.trim() || '{}');
				if (typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error("Input must be a JSON object.");
				if (mappings['/gemini'] || mappings['/vertex']) throw new Error("Cannot set reserved paths: /gemini, /vertex.");
				const result = await apiRequest('/api-mappings', 'POST', { mappings });
				if (result) {
					showMessage(result.message, 'success');
					loadApiMappings();
				}
			} catch (e) {
				showMessage(`Save API Mappings failed: ${e.message}`, 'error');
			}
		};
		loadApiMappings();
	}

	// --- UI State & Initialization ---
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

	dom.loginButton.onclick = async () => {
		const password = dom.loginPasswordInput.value;
		if (!password) return showMessage('Password is required.', 'error');
		const result = await apiRequest('/login', 'POST', { password });
		if (result?.success) {
			adminPassword = password;
			showMessage(result.message, 'success');
			showManagementSection();
		}
	};

	dom.loginPasswordInput.addEventListener('keypress', (e) => {
		if (e.key === 'Enter') dom.loginButton.click();
	});

	dom.logoutButton.onclick = () => {
		showMessage('Logged out.', 'success');
		showLoginSection();
	};

	// Initial state
	showLoginSection();
});