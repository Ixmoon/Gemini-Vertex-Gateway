// src/manage.js
document.addEventListener('DOMContentLoaded', () => {
	// --- 全局状态与常量 ---
	const API_BASE_URL = '/api/manage';
	let adminPassword = null;

	// --- 辅助函数 ---

	/** 显示消息提示 */
	function showMessage(message, type = 'success') {
		const area = document.getElementById('message-area');
		if (!area) return;
		area.textContent = message;
		area.className = type;
		area.classList.remove('hidden');
		if (area.timeoutId) clearTimeout(area.timeoutId);
		area.timeoutId = setTimeout(() => area.classList.add('hidden'), 5000);
	}

	/** 封装 API 请求 */
	async function apiRequest(endpoint, method = 'GET', body = null) {
		const headers = { 'Content-Type': 'application/json' };
		if (endpoint !== '/login' && adminPassword) {
			headers['X-Admin-Password'] = adminPassword;
		}

		try {
			const response = await fetch(`${API_BASE_URL}${endpoint}`, {
				method,
				headers,
				body: body ? JSON.stringify(body) : null,
			});
			const data = await response.json();
			// 后端返回的格式是 { success: boolean, ... }
			if (!data.success) {
				throw new Error(data.error || data.message || `HTTP ${response.status}`);
			}
			if (data.message) { // 只在有消息时显示
				showMessage(data.message, 'success');
			}
			return data;
		} catch (err) {
			showMessage(`操作失败: ${err.message}`, 'error');
			if (err.message && err.message.toLowerCase().includes("unauthorized")) {
				showLoginSection();
			}
			return null;
		}
	}

	/** 渲染项目列表 (支持删除) */
	function renderList(listElementId, items, deleteEndpoint, loadDataFunc) {
		const listElement = document.getElementById(listElementId);
		if (!listElement) return;

		listElement.innerHTML = '';
		if (!items || items.length === 0) {
			listElement.innerHTML = '<li>列表为空</li>';
			return;
		}
		items.forEach(item => {
			const li = document.createElement('li');
			const text = (typeof item === 'string' && item.length > 8) ? `${item.substring(0, 4)}...${item.substring(item.length - 4)}` : String(item);
			li.innerHTML = `<span>${text}</span>`;
			if (typeof item === 'string' && item.length > 8) li.title = item;

			const deleteBtn = document.createElement('button');
			deleteBtn.textContent = '删除';
			deleteBtn.onclick = async () => {
				if (confirm(`确定要删除 "${text}" 吗?`)) {
					if (await apiRequest(deleteEndpoint, 'DELETE', { key: item })) {
						loadDataFunc();
					}
				}
			};
			li.appendChild(deleteBtn);
			listElement.appendChild(li);
		});
	}

	/** 设置 JSON 列表管理逻辑 */
	function setupJsonListManagement(config) {
		const { prefix, itemName, fetchEndpoint, saveEndpoint, clearEndpoint, saveBodyKey, deleteEndpoint } = config;
		const textarea = document.getElementById(`textarea-${prefix}`);
		const singleInput = document.getElementById(`input-${prefix}-single`);

		if (!textarea || !singleInput) {
			console.error(`初始化 ${itemName} 管理区失败: 缺少必要的 DOM 元素 (前缀: ${prefix})`);
			return;
		}
		
		const loadData = async () => {
			const res = await apiRequest(fetchEndpoint);
			const items = res?.data || [];
			textarea.value = JSON.stringify(items, null, 2);
			renderList(`list-${prefix}`, items, deleteEndpoint, loadData);
		};

		// 绑定事件
		document.getElementById(`button-${prefix}-add-single`)?.addEventListener('click', () => {
			if (!singleInput.value.trim()) return;
			try {
				const currentItems = JSON.parse(textarea.value || '[]');
				currentItems.push(singleInput.value.trim());
				textarea.value = JSON.stringify(currentItems, null, 2);
				singleInput.value = '';
			} catch(e) {
				showMessage(`编辑区内容不是有效的JSON数组，无法添加。`, 'error');
			}
		});

		document.getElementById(`button-${prefix}-save`)?.addEventListener('click', async () => {
			try {
				const items = JSON.parse(textarea.value);
				if (!Array.isArray(items)) throw new Error("必须是 JSON 数组");
				await apiRequest(saveEndpoint, 'POST', { [saveBodyKey]: items });
				loadData();
			} catch (e) {
				showMessage(`保存失败: ${e.message}`, 'error');
			}
		});

		document.getElementById(`button-${prefix}-clear`)?.addEventListener('click', async () => {
			if (confirm(`确定要清空所有 ${itemName} 吗？`)) {
				if (await apiRequest(clearEndpoint, 'DELETE')) {
					loadData();
				}
			}
		});

		loadData();
	}

	// --- 数据加载函数 ---

	async function loadTriggerKeys() {
		const res = await apiRequest('/trigger-keys');
		renderList('list-trigger-keys', res?.data || [], '/trigger-keys', loadTriggerKeys);
	}

	async function loadFallbackKey() {
		const res = await apiRequest('/fallback-key');
		const input = document.getElementById('input-fallback-key');
		const current = document.getElementById('current-fallback-key');
		if (input) input.value = res?.data || '';
		if (current) current.textContent = res?.data || '未设置';
	}

	async function loadApiRetryLimit() {
		const res = await apiRequest('/retry-limit');
		const input = document.getElementById('input-api-retry-limit');
		const current = document.getElementById('current-api-retry-limit');
		const limit = res?.data ?? 3;
		if (input) input.value = limit;
		if (current) current.textContent = limit;
	}

	async function loadGcpSettings() {
		const credsRes = await apiRequest('/gcp-credentials');
		const credsTextarea = document.getElementById('textarea-gcp-credentials');
		const credsStatus = document.getElementById('current-gcp-credentials-status');
		if(credsTextarea) credsTextarea.value = credsRes?.data || '';
		if(credsStatus) credsStatus.textContent = credsRes?.data ? '已设置' : '未设置';

		const locRes = await apiRequest('/gcp-location');
		const locInput = document.getElementById('input-gcp-location');
		const locCurrent = document.getElementById('current-gcp-location');
		const location = locRes?.data || 'global';
		if(locInput) locInput.value = location;
		if(locCurrent) locCurrent.textContent = location;
	}
	
	function addMappingRow(prefix = '', url = '') {
		const tbody = document.getElementById('tbody-api-mappings');
		if (!tbody) return;
		const row = tbody.insertRow();
		row.innerHTML = `
			<td><input type="text" value="${prefix}" placeholder="/gemini"></td>
			<td><input type="text" value="${url}" placeholder="https://generativelanguage.googleapis.com"></td>
			<td><button class="danger delete-row">删除</button></td>
		`;
		row.querySelector('.delete-row')?.addEventListener('click', () => row.remove());
	}

	async function loadApiMappings() {
		const res = await apiRequest('/api-mappings');
		const tbody = document.getElementById('tbody-api-mappings');
		if (!tbody) return;
		tbody.innerHTML = '';
		Object.entries(res?.data || {}).forEach(([p, u]) => addMappingRow(p, u));
	}


	// --- UI 状态与事件绑定 ---

	function showLoginSection() {
		adminPassword = null;
		document.getElementById('login-section')?.classList.remove('hidden');
		document.getElementById('management-section')?.classList.add('hidden');
	}

	function showManagementSection() {
		document.getElementById('login-section')?.classList.add('hidden');
		document.getElementById('management-section')?.classList.remove('hidden');

		// 加载所有数据
		loadTriggerKeys();
		loadFallbackKey();
		loadApiRetryLimit();
		loadGcpSettings();
		loadApiMappings();
		
		// 初始化列表管理
		setupJsonListManagement({ prefix: 'pool-keys', itemName: '密钥池密钥', fetchEndpoint: '/pool-keys', saveEndpoint: '/pool-keys', clearEndpoint: '/pool-keys/all', saveBodyKey: 'keys', deleteEndpoint: '/pool-keys' });
		setupJsonListManagement({ prefix: 'fallback-models', itemName: '回退模型', fetchEndpoint: '/fallback-models', saveEndpoint: '/fallback-models', clearEndpoint: '/fallback-models/all', saveBodyKey: 'models' });
		setupJsonListManagement({ prefix: 'vertex-models', itemName: 'Vertex 模型', fetchEndpoint: '/vertex-models', saveEndpoint: '/vertex-models', clearEndpoint: '/vertex-models/all', saveBodyKey: 'models' });
	}

	/** [核心] 绑定所有事件监听器，使用可选链 ?. 防止因元素不存在而崩溃 */
	function bindEventListeners() {
		// 登录/登出
		document.getElementById('login-button')?.addEventListener('click', async () => {
			const passwordInput = document.getElementById('login-password');
			const password = passwordInput?.value;
			if (!password) return;
			// 登录API不使用通用apiRequest，因其成功/失败逻辑特殊
			const response = await fetch(`${API_BASE_URL}/login`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
			});
			const data = await response.json();
			if (data.success) {
				adminPassword = password;
				showMessage(data.message, 'success');
				showManagementSection();
			} else {
				showMessage(data.error, 'error');
			}
		});
		document.getElementById('login-password')?.addEventListener('keyup', (e) => e.key === 'Enter' && document.getElementById('login-button')?.click());
		document.getElementById('logout-button')?.addEventListener('click', showLoginSection);

		// 触发密钥
		document.getElementById('button-trigger-key-add')?.addEventListener('click', async () => {
			const input = document.getElementById('input-trigger-key-single');
			const key = input?.value.trim();
			if (key && await apiRequest('/trigger-keys', 'POST', { key })) {
				if(input) input.value = '';
				loadTriggerKeys();
			}
		});

		// 指定密钥
		document.getElementById('button-fallback-key-set')?.addEventListener('click', async () => {
			const key = document.getElementById('input-fallback-key')?.value.trim();
			if (await apiRequest('/fallback-key', 'POST', { key })) loadFallbackKey();
		});
		document.getElementById('button-fallback-key-clear')?.addEventListener('click', async () => {
			if (await apiRequest('/fallback-key', 'POST', { key: null })) loadFallbackKey();
		});

		// 重试次数
		document.getElementById('button-api-retry-limit-set')?.addEventListener('click', async () => {
			const limit = parseInt(document.getElementById('input-api-retry-limit')?.value, 10);
			if (!isNaN(limit) && await apiRequest('/retry-limit', 'POST', { limit })) loadApiRetryLimit();
		});

		// GCP
		document.getElementById('button-gcp-settings-save')?.addEventListener('click', async () => {
			const credentials = document.getElementById('textarea-gcp-credentials')?.value.trim();
			const location = document.getElementById('input-gcp-location')?.value.trim();
			await apiRequest('/gcp-credentials', 'POST', { credentials });
			await apiRequest('/gcp-location', 'POST', { location });
			loadGcpSettings();
		});
		
		// API 映射
		document.getElementById('button-api-mappings-add-row')?.addEventListener('click', () => addMappingRow());
		document.getElementById('button-api-mappings-save')?.addEventListener('click', async () => {
			const mappings = {};
			const tbody = document.getElementById('tbody-api-mappings');
			if(tbody) {
				for (const row of tbody.rows) {
					const prefix = row.cells[0].querySelector('input')?.value.trim();
					const url = row.cells[1].querySelector('input')?.value.trim();
					if (prefix && url) mappings[prefix] = url;
				}
			}
			if (await apiRequest('/api-mappings', 'POST', { mappings })) loadApiMappings();
		});
		document.getElementById('button-api-mappings-clear')?.addEventListener('click', async () => {
			if (confirm('确定要清空所有API映射吗？') && await apiRequest('/api-mappings', 'DELETE')) {
				loadApiMappings();
			}
		});
	}

	// --- 初始化 ---
	bindEventListeners();
	showLoginSection();
});