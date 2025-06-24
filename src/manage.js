/**
 * @file 管理界面前端逻辑
 * @description
 * 这是一个单页应用(SPA)，用于与后台管理API进行交互，提供一个用户友好的界面来配置网关。
 * 主要重构点:
 * - DOMElements: 集中管理DOM元素，按需获取，避免全局污染和null引用。
 * - apiRequest: 统一的API请求函数，自动处理认证头、错误消息和会话过期。
 * - renderList: 可复用的列表渲染函数。
 * - setupJsonListManagement: 一个工厂函数，为多个相似的配置项(密钥池、模型列表)生成完整的管理UI逻辑，
 *   极大地减少了重复代码。
 * - UI交互: 增强了用户体验，如JSON格式验证、即时预览、清晰的提示信息。
 */
document.addEventListener('DOMContentLoaded', () => {
	// --- 全局常量与状态 ---
	const API_BASE_URL = '/api/manage';
	let currentPassword = null;

	// --- DOM 元素引用管理器 ---
	const DOMElements = {
		_cache: {},
		get: function(id) {
			if (!this._cache[id]) {
				this._cache[id] = document.getElementById(id);
				if (!this._cache[id]) {
					console.error(`DOM Element with ID "${id}" not found.`);
					// 返回一个安全的“空”对象，防止脚本因null引用而崩溃
					return new Proxy({}, { get: () => () => {} });
				}
			}
			return this._cache[id];
		},
		loginSection: document.getElementById('login-section'),
		managementSection: document.getElementById('management-section'),
		messageArea: document.getElementById('message-area'),
	};

	// --- 核心功能函数 ---

	/** 显示消息提示 */
	function showMessage(message, type = 'success') {
		const area = DOMElements.messageArea;
		area.textContent = message;
		area.className = type;
		area.classList.remove('hidden');
		if (area.timeoutId) clearTimeout(area.timeoutId);
		area.timeoutId = setTimeout(() => area.classList.add('hidden'), 5000);
	}

	/** 封装 API 请求 */
	async function apiRequest(endpoint, method = 'GET', body = null) {
		const headers = { 'Content-Type': 'application/json' };
		// 除登录请求外，所有请求都带上密码头
		if (endpoint !== '/login' && currentPassword) {
			headers['X-Admin-Password'] = currentPassword;
		} else if (endpoint !== '/login' && !currentPassword) {
			showMessage('Error: Not logged in or session expired. Please log in again.', 'error');
			showLoginSection();
			return null;
		}

		try {
			const response = await fetch(`${API_BASE_URL}${endpoint}`, {
				method,
				headers,
				body: body ? JSON.stringify(body) : null
			});
			const data = await response.json().catch(() => ({}));

			if (!response.ok) {
				const errorMsg = data.error || data.message || `Error ${response.status}`;
				showMessage(errorMsg, 'error');
				if (response.status === 401) showLoginSection();
				return null;
			}
			return data;
		} catch (err) {
			showMessage(`Network or server error: ${err.message}`, 'error');
			return null;
		}
	}

	/** 渲染列表项到 UL 元素 */
	function renderList(listElement, items, config) {
		listElement.innerHTML = '';
		if (!items || items.length === 0) {
			listElement.innerHTML = '<li>List is empty.</li>';
			return;
		}
		items.forEach(item => {
			const li = document.createElement('li');
			const itemSpan = document.createElement('span');
			// 对长密钥进行部分隐藏，悬停显示完整内容
			itemSpan.textContent = (config.itemType === 'poolKey' && item.length > 8)
				? `${item.substring(0, 4)}...${item.substring(item.length - 4)}`
				: item;
			li.title = item;
			li.appendChild(itemSpan);

			if (config.deleteHandler) {
				const deleteBtn = document.createElement('button');
				deleteBtn.textContent = 'Delete';
				deleteBtn.className = 'danger';
				deleteBtn.onclick = async () => {
					if (confirm(`Are you sure you want to delete "${item}"?`)) {
						if (await config.deleteHandler(item)) {
							config.loadDataFunc?.(); // 删除成功后刷新
						}
					}
				};
				li.appendChild(deleteBtn);
			}
			listElement.appendChild(li);
		});
	}

	/**
	 * 设置 JSON 列表管理的通用逻辑 (工厂函数)
	 * @returns 返回一个加载此列表数据的函数
	 */
	function setupJsonListManagement(config) {
		const { sectionPrefix, itemType, itemName, fetchEndpoint, saveEndpoint, clearEndpoint, dataKey, bodyKey } = config;
		const textareaEl = DOMElements.get(`textarea-${sectionPrefix}`);
		const saveButtonEl = DOMElements.get(`button-${sectionPrefix}-save`);
		const clearButtonEl = DOMElements.get(`button-${sectionPrefix}-clear`);
		const listElement = DOMElements.get(`list-${sectionPrefix}`);
		const singleInputEl = DOMElements.get(`input-${sectionPrefix}-single`);
		const addSingleButtonEl = DOMElements.get(`button-${sectionPrefix}-add-single`);

		const loadData = async () => {
			const data = await apiRequest(fetchEndpoint);
			const itemsArray = data?.[dataKey] || [];
			textareaEl.value = JSON.stringify(itemsArray, null, 2);
			textareaEl.style.borderColor = '';
			renderList(listElement, itemsArray, { itemType, loadDataFunc: loadData });
		};

		addSingleButtonEl.onclick = () => {
			const newItem = singleInputEl.value.trim();
			if (!newItem) return;
			try {
				const currentItems = JSON.parse(textareaEl.value || '[]');
				if (!currentItems.includes(newItem)) {
					currentItems.push(newItem);
					textareaEl.value = JSON.stringify(currentItems, null, 2);
					textareaEl.dispatchEvent(new Event('input')); // 触发预览更新
					singleInputEl.value = '';
					showMessage(`Added to editor. Click "Save" to apply.`, 'success');
				} else {
					showMessage(`"${newItem}" already exists.`, 'error');
				}
			} catch (e) {
				showMessage(`Editor content is not a valid JSON array.`, 'error');
			}
		};

		saveButtonEl.onclick = async () => {
			try {
				const items = JSON.parse(textareaEl.value.trim() || '[]');
				if (!Array.isArray(items)) throw new Error('Input must be a JSON array.');
				const result = await apiRequest(saveEndpoint, 'POST', { [bodyKey]: items });
				if (result) {
					showMessage(result.message || `${itemName} list updated.`, 'success');
					loadData();
				}
			} catch (e) {
				showMessage(`Save failed: Invalid JSON format. ${e.message}`, 'error');
				textareaEl.style.borderColor = 'red';
			}
		};

		clearButtonEl.onclick = async () => {
			if (confirm(`Are you sure you want to clear all ${itemName}? This is irreversible.`)) {
				const result = await apiRequest(clearEndpoint, 'DELETE');
				if (result) {
					showMessage(result.message || `${itemName} cleared.`, 'success');
					loadData();
				}
			}
		};

		textareaEl.addEventListener('input', () => {
			try {
				const items = JSON.parse(textareaEl.value.trim() || '[]');
				if (!Array.isArray(items)) throw new Error();
				renderList(listElement, items, { itemType });
				textareaEl.style.borderColor = 'lightgreen';
			} catch (e) {
				textareaEl.style.borderColor = 'red';
			}
		});

		loadData();
		return loadData;
	}

	// --- 特定模块加载与事件处理 ---

	// 触发密钥
	async function loadTriggerKeys() {
		const data = await apiRequest('/trigger-keys');
		renderList(DOMElements.get('list-trigger-keys'), data?.keys || [], {
			itemType: 'triggerKey',
			loadDataFunc: loadTriggerKeys,
			deleteHandler: async (key) => !!(await apiRequest('/trigger-keys', 'DELETE', { key }))
		});
	}
	DOMElements.get('button-trigger-key-add').onclick = async () => {
		const inputEl = DOMElements.get('input-trigger-key-single');
		const key = inputEl.value.trim();
		if (key && await apiRequest('/trigger-keys', 'POST', { key })) {
			inputEl.value = '';
			loadTriggerKeys();
		}
	};

	// 指定密钥 (Fallback Key)
	async function loadFallbackKey() {
		const data = await apiRequest('/fallback-key');
		const key = data?.key || '';
		DOMElements.get('input-fallback-key').value = key;
		const currentSpan = DOMElements.get('current-fallback-key');
		currentSpan.textContent = key ? `${key.substring(0, 4)}...` : 'Not Set';
		currentSpan.title = key;
	}
	DOMElements.get('button-fallback-key-set').onclick = async () => {
		const key = DOMElements.get('input-fallback-key').value.trim();
		if (await apiRequest('/fallback-key', 'POST', { key })) {
			showMessage('Fallback key updated.', 'success');
			loadFallbackKey();
		}
	};
	DOMElements.get('button-fallback-key-clear').onclick = DOMElements.get('button-fallback-key-set'); // 清除也是设置为空

	// API 重试次数
	async function loadApiRetryLimit() {
		const data = await apiRequest('/retry-limit');
		const limit = data?.limit ?? 3;
		DOMElements.get('input-api-retry-limit').value = limit;
		DOMElements.get('current-api-retry-limit').textContent = limit;
	}
	DOMElements.get('button-api-retry-limit-set').onclick = async () => {
		const limit = parseInt(DOMElements.get('input-api-retry-limit').value, 10);
		if (isNaN(limit) || limit < 1) return showMessage('Retry limit must be a positive integer.', 'error');
		if (await apiRequest('/retry-limit', 'POST', { limit })) {
			showMessage('API retry limit updated.', 'success');
			loadApiRetryLimit();
		}
	};

	// GCP 设置
	async function loadGcpSettings() {
		const [credsData, locData] = await Promise.all([
			apiRequest('/gcp-credentials'),
			apiRequest('/gcp-location')
		]);
		if (credsData) {
			DOMElements.get('textarea-gcp-credentials').value = credsData.credentials || '';
			DOMElements.get('current-gcp-credentials-status').textContent = credsData.credentials ? 'Set' : 'Not Set';
		}
		if (locData) {
			DOMElements.get('input-gcp-location').value = locData.location || '';
			DOMElements.get('current-gcp-location').textContent = locData.location || 'global';
		}
	}
	DOMElements.get('button-gcp-settings-save').onclick = async () => {
		const credentials = DOMElements.get('textarea-gcp-credentials').value.trim();
		const location = DOMElements.get('input-gcp-location').value.trim();
		const [credResult, locResult] = await Promise.all([
			apiRequest('/gcp-credentials', 'POST', { credentials }),
			apiRequest('/gcp-location', 'POST', { location })
		]);
		if (credResult && locResult) {
			showMessage('GCP settings saved.', 'success');
			loadGcpSettings();
		}
	};

	// API 路径映射
	async function loadApiMappings() {
		const data = await apiRequest('/api-mappings');
		renderApiMappingsTable(data?.mappings || {});
	}
	function renderApiMappingsTable(mappings) {
		const tbody = DOMElements.get('tbody-api-mappings');
		tbody.innerHTML = '';
		Object.entries(mappings).forEach(([prefix, url]) => addMappingRow(prefix, url));
		updateJsonPreviewFromTable();
	}
	function addMappingRow(prefix = '', url = '') {
		const row = DOMElements.get('tbody-api-mappings').insertRow();
		row.innerHTML = `
			<td><input type="text" value="${prefix}" placeholder="/prefix"></td>
			<td><input type="text" value="${url}" placeholder="https://target.url"></td>
			<td><button class="danger delete-row">X</button></td>`;
		row.querySelectorAll('input').forEach(input => input.addEventListener('input', updateJsonPreviewFromTable));
		row.querySelector('.delete-row').addEventListener('click', () => {
			row.remove();
			updateJsonPreviewFromTable();
		});
	}
	function updateJsonPreviewFromTable() {
		const mappings = {};
		let isValid = true;
		for (const row of DOMElements.get('tbody-api-mappings').rows) {
			const prefixInput = row.cells[0].querySelector('input');
			const urlInput = row.cells[1].querySelector('input');
			const prefix = prefixInput.value.trim();
			const url = urlInput.value.trim();
			if (prefix && url) {
				mappings[prefix] = url;
				prefixInput.style.borderColor = prefix.startsWith('/') ? '' : 'red';
				try { new URL(url); urlInput.style.borderColor = ''; } catch { urlInput.style.borderColor = 'red'; isValid = false; }
			} else if (prefix || url) {
				isValid = false; // Incomplete row
			}
		}
		const textarea = DOMElements.get('textarea-api-mappings-preview');
		textarea.value = JSON.stringify(mappings, null, 2);
		textarea.style.borderColor = isValid ? '' : 'orange';
	}
	DOMElements.get('button-api-mappings-add-row').onclick = () => addMappingRow();
	DOMElements.get('button-api-mappings-save').onclick = async () => {
		try {
			const mappings = JSON.parse(DOMElements.get('textarea-api-mappings-preview').value);
			if (await apiRequest('/api-mappings', 'POST', { mappings })) {
				showMessage('API mappings saved.', 'success');
				loadApiMappings();
			}
		} catch (e) {
			showMessage(`Save failed: Invalid JSON. ${e.message}`, 'error');
		}
	};
	DOMElements.get('button-api-mappings-clear').onclick = async () => {
		if (confirm('Clear all API mappings?')) {
			if (await apiRequest('/api-mappings', 'DELETE')) {
				showMessage('API mappings cleared.', 'success');
				loadApiMappings();
			}
		}
	};

	// --- UI 状态管理 ---
	function showLoginSection() {
		currentPassword = null;
		DOMElements.loginSection.classList.remove('hidden');
		DOMElements.managementSection.classList.add('hidden');
	}

	function showManagementSection() {
		DOMElements.loginSection.classList.add('hidden');
		DOMElements.managementSection.classList.remove('hidden');

		loadTriggerKeys();
		loadFallbackKey();
		loadApiRetryLimit();
		loadGcpSettings();
		loadApiMappings();

		setupJsonListManagement({
			sectionPrefix: 'pool-keys', itemType: 'poolKey', itemName: 'Pool Keys',
			fetchEndpoint: '/pool-keys', saveEndpoint: '/pool-keys', clearEndpoint: '/pool-keys/all',
			dataKey: 'keys', bodyKey: 'keys'
		});
		setupJsonListManagement({
			sectionPrefix: 'fallback-models', itemType: 'fallbackModel', itemName: 'Fallback Models',
			fetchEndpoint: '/fallback-models', saveEndpoint: '/fallback-models', clearEndpoint: '/fallback-models/all',
			dataKey: 'models', bodyKey: 'models'
		});
		setupJsonListManagement({
			sectionPrefix: 'vertex-models', itemType: 'vertexModel', itemName: 'Vertex Models',
			fetchEndpoint: '/vertex-models', saveEndpoint: '/vertex-models', clearEndpoint: '/vertex-models/all',
			dataKey: 'models', bodyKey: 'models'
		});
	}

	// --- 登录/登出事件 ---
	DOMElements.get('login-button').onclick = async () => {
		const password = DOMElements.get('login-password').value;
		if (!password) return showMessage('Please enter a password.', 'error');
		const result = await apiRequest('/login', 'POST', { password });
		if (result?.success) {
			currentPassword = password;
			showMessage('Login successful!', 'success');
			showManagementSection();
		} else {
			DOMElements.get('login-password').value = '';
		}
	};
	DOMElements.get('logout-button').onclick = showLoginSection;

	// --- 初始化 ---
	showLoginSection();
});