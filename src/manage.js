document.addEventListener('DOMContentLoaded', () => {
	// --- 全局状态与常量 ---
	const API_BASE_URL = '/api/manage';
	let adminPassword = null;

	// --- DOM 元素缓存 ---
	const dom = new Proxy({}, { get: (target, prop) => target[prop] || (target[prop] = document.getElementById(prop)) });

	// --- 核心功能 ---

	/** 显示消息提示 */
	function showMessage(message, type = 'success') {
		const area = dom.messageArea;
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
			if (!data.success) {
				throw new Error(data.error || `HTTP ${response.status}`);
			}
			showMessage(data.message || '操作成功', 'success');
			return data;
		} catch (err) {
			showMessage(`操作失败: ${err.message}`, 'error');
			if (err.message.includes("Unauthorized")) showLoginSection();
			return null;
		}
	}

	/** 渲染项目列表 (支持删除) */
	function renderList(listElement, items, deleteEndpoint, loadDataFunc) {
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
		const textarea = dom[`textarea-${prefix}`];
		const list = dom[`list-${prefix}`];
		const singleInput = dom[`input-${prefix}-single`];

		const loadData = async () => {
			const res = await apiRequest(fetchEndpoint);
			const items = res?.data || [];
			textarea.value = JSON.stringify(items, null, 2);
			renderList(list, items, deleteEndpoint, loadData); // 渲染时传入删除逻辑
		};

		dom[`button-${prefix}-add-single`].onclick = () => {
			if (!singleInput.value.trim()) return;
			const currentItems = JSON.parse(textarea.value);
			currentItems.push(singleInput.value.trim());
			textarea.value = JSON.stringify(currentItems, null, 2);
			singleInput.value = '';
		};

		dom[`button-${prefix}-save`].onclick = async () => {
			try {
				const items = JSON.parse(textarea.value);
				if (!Array.isArray(items)) throw new Error("必须是 JSON 数组");
				await apiRequest(saveEndpoint, 'POST', { [saveBodyKey]: items });
				loadData();
			} catch (e) {
				showMessage(`保存失败: ${e.message}`, 'error');
			}
		};

		dom[`button-${prefix}-clear`].onclick = async () => {
			if (confirm(`确定要清空所有 ${itemName} 吗？`)) {
				if (await apiRequest(clearEndpoint, 'DELETE')) {
					loadData();
				}
			}
		};

		loadData();
	}

	// --- 特定模块加载与事件处理 ---

	// 触发密钥
	async function loadTriggerKeys() {
		const res = await apiRequest('/trigger-keys');
		renderList(dom['list-trigger-keys'], res?.data || [], '/trigger-keys', loadTriggerKeys);
	}
	dom['button-trigger-key-add'].onclick = async () => {
		const key = dom['input-trigger-key-single'].value.trim();
		if (key && await apiRequest('/trigger-keys', 'POST', { key })) {
			dom['input-trigger-key-single'].value = '';
			loadTriggerKeys();
		}
	};

	// 指定密钥 (Fallback Key)
	async function loadFallbackKey() {
		const res = await apiRequest('/fallback-key');
		dom['input-fallback-key'].value = res?.data || '';
		dom['current-fallback-key'].textContent = res?.data || '未设置';
	}
	dom['button-fallback-key-set'].onclick = async () => {
		const key = dom['input-fallback-key'].value.trim();
		if (await apiRequest('/fallback-key', 'POST', { key })) loadFallbackKey();
	};
	dom['button-fallback-key-clear'].onclick = async () => {
		if (await apiRequest('/fallback-key', 'POST', { key: null })) loadFallbackKey();
	};

	// API 重试次数
	async function loadApiRetryLimit() {
		const res = await apiRequest('/retry-limit');
		dom['input-api-retry-limit'].value = res?.data || '3';
		dom['current-api-retry-limit'].textContent = res?.data || '3';
	}
	dom['button-api-retry-limit-set'].onclick = async () => {
		const limit = parseInt(dom['input-api-retry-limit'].value, 10);
		if (!isNaN(limit) && await apiRequest('/retry-limit', 'POST', { limit })) loadApiRetryLimit();
	};

	// GCP 设置
	async function loadGcpSettings() {
		const credsRes = await apiRequest('/gcp-credentials');
		dom['textarea-gcp-credentials'].value = credsRes?.data || '';
		dom['current-gcp-credentials-status'].textContent = credsRes?.data ? '已设置' : '未设置';
		const locRes = await apiRequest('/gcp-location');
		dom['input-gcp-location'].value = locRes?.data || 'global';
		dom['current-gcp-location'].textContent = locRes?.data || 'global';
	}
	dom['button-gcp-settings-save'].onclick = async () => {
		const credentials = dom['textarea-gcp-credentials'].value.trim();
		const location = dom['input-gcp-location'].value.trim();
		await apiRequest('/gcp-credentials', 'POST', { credentials });
		await apiRequest('/gcp-location', 'POST', { location });
		loadGcpSettings();
	};

	// API 路径映射
	function addMappingRow(prefix = '', url = '') {
		const row = dom['tbody-api-mappings'].insertRow();
		row.innerHTML = `
			<td><input type="text" value="${prefix}" placeholder="/gemini"></td>
			<td><input type="text" value="${url}" placeholder="https://generativelanguage.googleapis.com"></td>
			<td><button class="danger delete-row">删除</button></td>
		`;
		row.querySelector('.delete-row').onclick = () => row.remove();
	}
	async function loadApiMappings() {
		const res = await apiRequest('/api-mappings');
		dom['tbody-api-mappings'].innerHTML = '';
		Object.entries(res?.data || {}).forEach(([p, u]) => addMappingRow(p, u));
	}
	dom['button-api-mappings-add-row'].onclick = () => addMappingRow();
	dom['button-api-mappings-save'].onclick = async () => {
		const mappings = {};
		for (const row of dom['tbody-api-mappings'].rows) {
			const prefix = row.cells[0].querySelector('input').value.trim();
			const url = row.cells[1].querySelector('input').value.trim();
			if (prefix && url) mappings[prefix] = url;
		}
		if (await apiRequest('/api-mappings', 'POST', { mappings })) loadApiMappings();
	};
    dom['button-api-mappings-clear'].onclick = async () => {
        if (confirm('确定要清空所有API映射吗？') && await apiRequest('/api-mappings', 'DELETE')) {
            loadApiMappings();
        }
    };


	// --- UI 状态管理 ---
	function showLoginSection() {
		adminPassword = null;
		dom.loginSection.classList.remove('hidden');
		dom.managementSection.classList.add('hidden');
	}

	function showManagementSection() {
		dom.loginSection.classList.add('hidden');
		dom.managementSection.classList.remove('hidden');

		loadTriggerKeys();
		loadFallbackKey();
		loadApiRetryLimit();
		loadGcpSettings();
		loadApiMappings();
		
		setupJsonListManagement({ prefix: 'pool-keys', itemName: '密钥池密钥', fetchEndpoint: '/pool-keys', saveEndpoint: '/pool-keys', clearEndpoint: '/pool-keys/all', saveBodyKey: 'keys', deleteEndpoint: '/pool-keys' });
		setupJsonListManagement({ prefix: 'fallback-models', itemName: '回退模型', fetchEndpoint: '/fallback-models', saveEndpoint: '/fallback-models', clearEndpoint: '/fallback-models/all', saveBodyKey: 'models' });
		setupJsonListManagement({ prefix: 'vertex-models', itemName: 'Vertex 模型', fetchEndpoint: '/vertex-models', saveEndpoint: '/vertex-models', clearEndpoint: '/vertex-models/all', saveBodyKey: 'models' });
	}

	// --- 登录/登出事件 ---
	dom.loginButton.onclick = async () => {
		const password = dom.loginPasswordInput.value;
		if (!password) return;
		// 不使用封装的apiRequest，因其成功/失败逻辑不同
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
	};
	dom.loginPasswordInput.addEventListener('keyup', (e) => e.key === 'Enter' && dom.loginButton.click());
	dom.logoutButton.onclick = showLoginSection;

	// --- 初始化 ---
	showLoginSection();
});