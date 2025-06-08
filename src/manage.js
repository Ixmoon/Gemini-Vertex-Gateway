// src/manage.js (重构版)

document.addEventListener('DOMContentLoaded', () => {
	// --- 全局常量与状态 ---
	const API_BASE_URL = '/api/manage';
	let currentPassword = null; // 存储管理员密码

	// --- DOM 元素引用 ---
	// 使用一个对象来存储DOM元素的引用，按需获取
	const DOMElements = {
		messageArea: document.getElementById('message-area'),
		loginSection: document.getElementById('login-section'),
		managementSection: document.getElementById('management-section'),
		loginPasswordInput: document.getElementById('login-password'),
		loginButton: document.getElementById('login-button'),
		logoutButton: document.getElementById('logout-button'),

		// 获取其他元素的函数，避免启动时获取不存在的元素
		get: function(id) {
			if (!this[id]) {
				this[id] = document.getElementById(id);
				if (!this[id]) {
					console.error(`DOM Element with ID "${id}" not found.`);
					// 返回一个假的元素或抛出错误，以避免null引用
					return { value: '', textContent: '', classList: { add: () => {}, remove: () => {} }, style: {}, focus: () => {}, dispatchEvent: () => {}, onclick: null, addEventListener: () => {}, insertRow: () => ({ insertCell: () => ({ appendChild: () => {} }) }), rows: [], querySelector: () => null, removeAttribute: () => {} };
				}
			}
			return this[id];
		}
	};

	// --- 核心功能函数 ---

	/**
	 * 显示消息提示
	 * @param {string} message - 消息内容
	 * @param {'success'|'error'} type - 消息类型
	 */
	function showMessage(message, type = 'success') {
		const area = DOMElements.messageArea;
		area.textContent = message;
		area.className = type; // 设置为 success 或 error
		area.classList.remove('hidden');
		// 清除之前的定时器（如果有）
		if (area.timeoutId) {
			clearTimeout(area.timeoutId);
		}
		area.timeoutId = setTimeout(() => {
			area.textContent = '';
			area.classList.add('hidden');
			area.className = 'hidden'; // 清除类型类
			area.timeoutId = null;
		}, 5000); // 5秒后隐藏
	}

	/**
	 * 封装 API 请求
	 * @param {string} endpoint - API 端点
	 * @param {'GET'|'POST'|'DELETE'} method - HTTP 方法
	 * @param {object|null} body - 请求体
	 * @returns {Promise<object|null>} API 响应数据或 null
	 */
	async function apiRequest(endpoint, method = 'GET', body = null) {
		const headers = { 'Content-Type': 'application/json' };
		if (endpoint !== '/login' && currentPassword) {
			headers['X-Admin-Password'] = currentPassword;
		} else if (endpoint !== '/login' && !currentPassword && method !== 'GET') {
			showMessage('错误：未登录或会话已过期。请重新登录。', 'error');
			showLoginSection();
			return null;
		}

		const options = { method, headers };
		if (body) {
			options.body = JSON.stringify(body);
		}

		try {
			const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
			const responseData = await response.json().catch(() => ({})); // 保证总有对象返回

			if (!response.ok) {
				const errorMsg = responseData.error || responseData.message || `错误 ${response.status}: ${response.statusText}`;
				showMessage(errorMsg, 'error');
				if (response.status === 401 || response.status === 403) {
					showLoginSection();
				}
				return null;
			}
			return responseData;
		} catch (err) {
			showMessage(`网络或服务器错误: ${err.message}`, 'error');
			console.error("API Request Error:", err);
			return null;
		}
	}

	/**
	 * 渲染列表项到 UL 元素
	 * @param {HTMLUListElement} listElement - 目标 UL 元素
	 * @param {Array<string>} items - 要渲染的字符串数组
	 * @param {object} config - 列表配置
	 * @param {'triggerKey'|'poolKey'|'fallbackModel'|'vertexModel'} config.itemType - 项目类型
	 * @param {Function} [config.deleteHandler] - (可选) 删除按钮的处理函数
	 * @param {Function} [config.loadDataFunc] - (可选) 删除后重新加载数据的函数
	 */
	function renderList(listElement, items, config) {
		listElement.innerHTML = ''; // 清空旧列表
		if (!items || items.length === 0) {
			listElement.innerHTML = '<li>列表为空</li>';
			return;
		}

		items.forEach(item => {
			const li = document.createElement('li');
			const itemSpan = document.createElement('span');

			// 密钥部分隐藏
			if (config.itemType === 'poolKey' && typeof item === 'string' && item.length > 8) {
				itemSpan.textContent = `${item.substring(0, 4)}...${item.substring(item.length - 4)}`;
				li.title = item; // 悬停显示完整密钥
			} else {
				itemSpan.textContent = String(item);
			}
			li.appendChild(itemSpan);

			// 添加删除按钮 (如果提供了删除处理器)
			if (config.deleteHandler) {
				const deleteBtn = document.createElement('button');
				deleteBtn.textContent = '删除';
				deleteBtn.onclick = async () => {
					if (confirm(`确定要删除 "${itemSpan.textContent}" 吗?`)) {
						const success = await config.deleteHandler(item); // 调用外部处理函数
						if (success && config.loadDataFunc) {
							config.loadDataFunc(); // 删除成功后刷新列表
						}
					}
				};
				li.appendChild(deleteBtn);
			}
			listElement.appendChild(li);
		});
	}

	/**
	 * 设置 JSON 编辑区和列表的通用管理逻辑
	 * @param {object} config
	 * @param {string} config.sectionPrefix - ID 前缀 (例如 'pool-keys')
	 * @param {string} config.itemType - 项目类型 ('poolKey', 'fallbackModel', 'vertexModel')
	 * @param {string} config.itemName - 用于消息的项目名称 (例如 "密钥池密钥")
	 * @param {string} config.fetchEndpoint - 获取数据的 API 端点
	 * @param {string} config.saveEndpoint - 保存数据的 API 端点 (POST)
	 * @param {string} config.clearEndpoint - 清空数据的 API 端点 (DELETE)
	 * @param {string} config.dataKey - API 响应中列表数据的键名 (例如 'keys', 'models')
	 * @param {string} config.bodyKey - 保存请求体中列表数据的键名 (例如 'keys', 'models')
	 * @returns {Function} 返回加载此列表数据的函数
	 */
	function setupJsonListManagement(config) {
		const singleInputEl = DOMElements.get(`input-${config.sectionPrefix}-single`);
		const addSingleButtonEl = DOMElements.get(`button-${config.sectionPrefix}-add-single`);
		const textareaEl = DOMElements.get(`textarea-${config.sectionPrefix}`);
		const saveButtonEl = DOMElements.get(`button-${config.sectionPrefix}-save`);
		const clearButtonEl = DOMElements.get(`button-${config.sectionPrefix}-clear`);
		const listElement = DOMElements.get(`list-${config.sectionPrefix}`);

		// 加载数据函数
		const loadData = async () => {
			const data = await apiRequest(config.fetchEndpoint);
			let itemsArray = [];
			if (data && data[config.dataKey]) {
				itemsArray = data[config.dataKey] || [];
				try {
					textareaEl.value = JSON.stringify(itemsArray, null, 2);
					textareaEl.style.borderColor = '';
				} catch (e) {
					textareaEl.value = `// 无法序列化: ${e.message}`;
					textareaEl.style.borderColor = 'red';
				}
			} else {
				textareaEl.value = '[]';
				textareaEl.style.borderColor = '';
			}
			// 渲染列表 (删除功能由各自的加载函数处理，因为触发密钥不同)
			 renderList(listElement, itemsArray, { itemType: config.itemType, loadDataFunc: loadData }); // 传递 loadData 用于刷新
		};

		// 添加单个项目到编辑区
		addSingleButtonEl.onclick = () => {
			const newItem = singleInputEl.value.trim();
			if (!newItem) {
				showMessage(`请输入要添加的单个 ${config.itemName}。`, 'error');
				singleInputEl.focus();
				return;
			}

			let currentItems = [];
			try {
				const currentJson = textareaEl.value.trim();
				if (currentJson) {
					currentItems = JSON.parse(currentJson);
					if (!Array.isArray(currentItems)) throw new Error("当前内容不是有效的 JSON 数组。");
				}
				textareaEl.style.borderColor = '';
			} catch (e) {
				showMessage(`无法添加：编辑区内容不是有效的 JSON 数组。请先修复或清空。\n${e.message}`, 'error');
				textareaEl.style.borderColor = 'red';
				textareaEl.focus();
				return;
			}

			if (currentItems.includes(newItem)) {
				showMessage(`${config.itemName} "${newItem}" 已存在于列表中。`, 'error');
				singleInputEl.focus();
				return;
			}

			currentItems.push(newItem);
			try {
				textareaEl.value = JSON.stringify(currentItems, null, 2);
				textareaEl.dispatchEvent(new Event('input', { bubbles: true })); // 触发 input 以更新列表和边框
				singleInputEl.value = ''; // 清空输入
				showMessage(`单个 ${config.itemName} "${newItem}" 已添加到编辑区，请记得点击下方按钮保存整个列表。`, 'success');
			} catch (stringifyError) {
				showMessage(`更新编辑区时发生内部错误。`, 'error');
				console.error("Error stringifying after single add:", stringifyError);
			}
		};

		// 保存按钮事件
		saveButtonEl.onclick = async () => {
			const jsonString = textareaEl.value.trim();
			let items = [];
			let isValidJson = true;

			if (!jsonString) {
				items = []; // 空字符串视为清空
			} else {
				try {
					items = JSON.parse(jsonString);
					if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) {
						throw new Error(`必须是一个有效的 JSON 字符串数组。`);
					}
					textareaEl.style.borderColor = '';
				} catch (e) {
					isValidJson = false;
					showMessage(`保存失败：输入的 ${config.itemName} 不是有效的 JSON 字符串数组。\n错误: ${e.message}`, 'error');
					textareaEl.style.borderColor = 'red';
				}
			}

			if (!isValidJson) return;

			const body = {};
			body[config.bodyKey] = items;
			const result = await apiRequest(config.saveEndpoint, 'POST', body);
			if (result) {
				showMessage(result.message || `${config.itemName} 列表已更新。`, 'success');
				textareaEl.style.borderColor = '';
				loadData(); // 重新加载以确认
			}
		};

		// 清空按钮事件
		clearButtonEl.onclick = async () => {
			if (confirm(`确定要清空所有 ${config.itemName} 吗？此操作不可撤销。`)) {
				const result = await apiRequest(config.clearEndpoint, 'DELETE');
				if (result) {
					showMessage(result.message || `${config.itemName} 已清空。`, 'success');
					loadData(); // 重新加载
				}
			}
		};

		// Textarea 输入事件 -> 更新列表预览和边框颜色
		textareaEl.addEventListener('input', () => {
			const jsonString = textareaEl.value.trim();
			if (!jsonString) {
				renderList(listElement, [], { itemType: config.itemType });
				textareaEl.style.borderColor = '';
				return;
			}
			try {
				const items = JSON.parse(jsonString);
				if (!Array.isArray(items) || !items.every(item => typeof item === 'string')) {
					throw new Error("无效的 JSON 字符串数组");
				}
				renderList(listElement, items, { itemType: config.itemType });
				textareaEl.style.borderColor = 'lightgreen';
			} catch (e) {
				textareaEl.style.borderColor = 'red';
				// 不实时更新列表，避免显示错误状态
			}
		});

		// 初始化加载
		loadData();
		return loadData; // 返回加载函数
	}


	// --- 特定模块加载与事件处理 ---

	// 触发密钥
	async function loadTriggerKeys() {
		const listElement = DOMElements.get('list-trigger-keys');
		const data = await apiRequest('/trigger-keys');
		const keys = (data && data.keys) ? data.keys : [];
		renderList(listElement, keys, {
			itemType: 'triggerKey',
			deleteHandler: async (key) => {
				const result = await apiRequest('/trigger-keys', 'DELETE', { key });
				if (result) {
					showMessage(result.message || '触发密钥已删除。', 'success');
					return true;
				}
				return false;
			},
			loadDataFunc: loadTriggerKeys // 删除后重新加载自己
		});
	}
	DOMElements.get('button-trigger-key-add').onclick = async () => {
		const inputEl = DOMElements.get('input-trigger-key-single');
		const key = inputEl.value.trim();
		if (!key) {
			showMessage('请输入要添加的触发密钥。', 'error');
			return;
		}
		const result = await apiRequest('/trigger-keys', 'POST', { key });
		if (result) {
			showMessage(result.message || '触发密钥已添加。', 'success');
			inputEl.value = '';
			loadTriggerKeys();
		}
	};

	// 指定密钥 (Fallback Key)
	async function loadFallbackKey() {
		const inputEl = DOMElements.get('input-fallback-key');
		const currentSpan = DOMElements.get('current-fallback-key');
		const data = await apiRequest('/fallback-key');
		const key = (data && data.key) ? data.key : null;

		inputEl.value = key || '';
		if (key && key.length > 8) {
			currentSpan.textContent = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
			currentSpan.title = key;
		} else if (key) {
			currentSpan.textContent = key;
			currentSpan.removeAttribute('title');
		} else {
			currentSpan.textContent = '未设置';
			currentSpan.removeAttribute('title');
		}
	}
	DOMElements.get('button-fallback-key-set').onclick = async () => {
		const key = DOMElements.get('input-fallback-key').value.trim(); // 允许空字符串清除
		const result = await apiRequest('/fallback-key', 'POST', { key: key });
		if (result) {
			showMessage(result.message || '指定密钥已更新。', 'success');
			loadFallbackKey();
		}
	};
	DOMElements.get('button-fallback-key-clear').onclick = async () => {
		if (confirm('确定要清除指定密钥吗？')) {
			const result = await apiRequest('/fallback-key', 'POST', { key: '' }); // 发送空密钥清除
			if (result) {
				showMessage(result.message || '指定密钥已清除。', 'success');
				loadFallbackKey(); // 刷新显示
			}
		}
	};

	// API 重试次数
	async function loadApiRetryLimit() {
		const inputEl = DOMElements.get('input-api-retry-limit');
		const currentSpan = DOMElements.get('current-api-retry-limit');
		const data = await apiRequest('/retry-limit');
		if (data && typeof data.limit === 'number') {
			inputEl.value = String(data.limit);
			currentSpan.textContent = String(data.limit);
		} else {
			inputEl.value = '';
			currentSpan.textContent = '加载失败';
		}
	}
	DOMElements.get('button-api-retry-limit-set').onclick = async () => {
		const inputEl = DOMElements.get('input-api-retry-limit');
		const limit = parseInt(inputEl.value, 10);
		if (isNaN(limit) || limit < 1) {
			showMessage('请输入一个大于等于 1 的整数。', 'error');
			return;
		}
		const result = await apiRequest('/retry-limit', 'POST', { limit });
		if (result) {
			showMessage(result.message || 'API 重试次数已更新。', 'success');
			loadApiRetryLimit();
		}
	};

	// GCP 设置
	async function loadGcpSettings() {
		const textareaCreds = DOMElements.get('textarea-gcp-credentials');
		const inputLocation = DOMElements.get('input-gcp-location');
		const currentLocationSpan = DOMElements.get('current-gcp-location');
		const currentCredsStatusSpan = DOMElements.get('current-gcp-credentials-status');

		// 加载 Location
		const locData = await apiRequest('/gcp-location');
		if (locData && locData.location) {
			inputLocation.value = locData.location;
			currentLocationSpan.textContent = locData.location;
		} else {
			inputLocation.value = '';
			currentLocationSpan.textContent = '加载失败或未设置';
		}

		// 加载凭证状态 (只获取是否存在，不获取内容)
		const credsData = await apiRequest('/gcp-credentials'); // GET 请求
		if (credsData) {
			 // 后端返回的 credentials 可能是 null 或空字符串，或者实际内容
			 if (credsData.credentials && credsData.credentials.trim() !== '') {
				textareaCreds.value = credsData.credentials; // 填充内容
				currentCredsStatusSpan.textContent = '已设置 (内容已填充)';
				currentCredsStatusSpan.style.color = 'green';
			} else {
				textareaCreds.value = ''; // 清空
				currentCredsStatusSpan.textContent = '未设置或为空';
				 currentCredsStatusSpan.style.color = '#6c757d';
			}
		} else {
			 textareaCreds.value = '';
			 currentCredsStatusSpan.textContent = '加载失败';
			 currentCredsStatusSpan.style.color = 'red';
		}
	}
	DOMElements.get('button-gcp-settings-save').onclick = async () => {
		const credentialsJson = DOMElements.get('textarea-gcp-credentials').value.trim();
		const defaultLocation = DOMElements.get('input-gcp-location').value.trim() || 'global';

		// 分别保存
		const credResult = await apiRequest('/gcp-credentials', 'POST', { credentials: credentialsJson });
		const locResult = await apiRequest('/gcp-location', 'POST', { location: defaultLocation });

		if (credResult && locResult) {
			showMessage('GCP 设置已保存。', 'success');
			loadGcpSettings(); // 重新加载以确认
		} else {
			showMessage('保存 GCP 设置时发生部分或全部错误。', 'error');
			// 即使部分失败也尝试重新加载，以显示成功的部分
			 loadGcpSettings();
		}
	};


	// API 路径映射
	const apiMappingsTableBody = DOMElements.get('tbody-api-mappings');
	const apiMappingsPreviewTextarea = DOMElements.get('textarea-api-mappings-preview');

	function addMappingRow(prefix = '', url = '') {
		const row = apiMappingsTableBody.insertRow();
		row.innerHTML = `
			<td><input type="text" value="${prefix}" placeholder="/example" style="width: calc(100% - 22px);"></td>
			<td><input type="text" value="${url}" placeholder="https://target.example.com" style="width: calc(100% - 22px);"></td>
			<td style="text-align: center;"><button class="danger delete-row">删除</button></td>
		`;
		// 为新行的输入框和删除按钮添加事件监听器
		row.querySelectorAll('input').forEach(input => input.addEventListener('input', updateJsonPreviewFromTable));
		row.querySelector('.delete-row').addEventListener('click', () => {
			row.remove();
			updateJsonPreviewFromTable();
		});
	}

	function updateJsonPreviewFromTable() {
		const mappings = {};
		const rows = apiMappingsTableBody.rows;
		let isValid = true;
		for (let i = 0; i < rows.length; i++) {
			const prefixInput = rows[i].cells[0].querySelector('input');
			const urlInput = rows[i].cells[1].querySelector('input');
			if (prefixInput && urlInput) {
				const prefix = prefixInput.value.trim();
				const url = urlInput.value.trim();
				if (prefix && url) {
					if (!prefix.startsWith('/')) {
					   prefixInput.style.borderColor = 'red';
					   isValid = false;
					} else {
					   prefixInput.style.borderColor = '';
					}
					try {
						new URL(url);
						urlInput.style.borderColor = '';
					} catch {
						urlInput.style.borderColor = 'red';
						isValid = false;
					}
					if (isValid) mappings[prefix] = url;
				} else if (prefix || url) {
					// 行不完整，标记错误
					prefixInput.style.borderColor = prefix ? '' : 'red';
					urlInput.style.borderColor = url ? '' : 'red';
					isValid = false;
				} else {
					 prefixInput.style.borderColor = '';
					 urlInput.style.borderColor = '';
				}
			}
		}

		try {
			apiMappingsPreviewTextarea.value = JSON.stringify(mappings, null, 2);
			apiMappingsPreviewTextarea.style.borderColor = isValid ? '' : 'orange'; // 用橙色表示表格内容不完整或无效
		} catch (e) {
			apiMappingsPreviewTextarea.value = "// 无法生成 JSON 预览";
			apiMappingsPreviewTextarea.style.borderColor = 'red';
		}
		return isValid; // 返回表格内容是否有效
	}

	 function renderApiMappingsTable(mappings) {
		apiMappingsTableBody.innerHTML = ''; // 清空
		if (mappings && typeof mappings === 'object' && Object.keys(mappings).length > 0) {
			for (const [prefix, url] of Object.entries(mappings)) {
				addMappingRow(prefix, url);
			}
		} else {
			 apiMappingsTableBody.innerHTML = '<tr><td colspan="3">列表为空或加载失败</td></tr>';
		}
		 updateJsonPreviewFromTable(); // 渲染后更新预览
	}


	async function loadApiMappings() {
		const data = await apiRequest('/api-mappings');
		const mappings = (data && data.mappings && typeof data.mappings === 'object') ? data.mappings : {};
		renderApiMappingsTable(mappings);
	}

	DOMElements.get('button-api-mappings-add-row').onclick = () => {
		 // 如果当前只有“列表为空”行，先清空
		const firstRow = apiMappingsTableBody.rows[0];
		if (firstRow && firstRow.cells.length === 1 && firstRow.cells[0].colSpan === 3) {
			apiMappingsTableBody.innerHTML = '';
		}
		addMappingRow();
		updateJsonPreviewFromTable();
	};

	DOMElements.get('button-api-mappings-save').onclick = async () => {
		let mappings = {};
		let isValidJson = true;
		const jsonString = apiMappingsPreviewTextarea.value.trim();

		if (!jsonString) {
			mappings = {}; // 空预览视为清空
		} else {
			try {
				mappings = JSON.parse(jsonString);
				if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
					throw new Error("JSON 必须是一个对象。");
				}
				// 严格验证
				for (const [prefix, url] of Object.entries(mappings)) {
					if (typeof prefix !== 'string' || !prefix.startsWith('/')) throw new Error(`前缀 "${prefix}" 必须是以 / 开头的字符串。`);
					if (typeof url !== 'string') throw new Error(`URL for prefix "${prefix}" 必须是字符串。`);
					try { new URL(url); } catch { throw new Error(`URL "${url}" (for prefix "${prefix}") 无效。`); }
				}
				apiMappingsPreviewTextarea.style.borderColor = '';
			} catch (e) {
				isValidJson = false;
				showMessage(`保存失败：API 映射预览中的 JSON 格式无效或内容不符合要求。\n错误: ${e.message}`, 'error');
				apiMappingsPreviewTextarea.style.borderColor = 'red';
			}
		}

		if (!isValidJson) return;

		const result = await apiRequest('/api-mappings', 'POST', { mappings });
		if (result) {
			showMessage(result.message || 'API 映射已保存。', 'success');
			loadApiMappings(); // 重新加载以确认和格式化表格
		}
	};

	DOMElements.get('button-api-mappings-clear').onclick = async () => {
		if (confirm('确定要清空所有 API 路径映射吗？此操作不可撤销。')) {
			const result = await apiRequest('/api-mappings', 'DELETE');
			if (result) {
				showMessage(result.message || 'API 映射已清空。', 'success');
				loadApiMappings(); // 重新加载会显示空状态
			}
		}
	};

	// JSON 预览区输入 -> 更新表格
	apiMappingsPreviewTextarea.addEventListener('input', () => {
		const jsonString = apiMappingsPreviewTextarea.value.trim();
		if (!jsonString) {
			renderApiMappingsTable({});
			apiMappingsPreviewTextarea.style.borderColor = '';
			return;
		}
		try {
			const mappings = JSON.parse(jsonString);
			if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
				throw new Error("无效的 JSON 对象");
			}
			 // 可选：添加验证逻辑
			 renderApiMappingsTable(mappings);
			apiMappingsPreviewTextarea.style.borderColor = 'lightgreen';
		} catch (e) {
			apiMappingsPreviewTextarea.style.borderColor = 'red';
			// 不更新表格，只标记预览区错误
		}
	});


	// --- UI 状态管理 ---
	function showLoginSection() {
		currentPassword = null;
		DOMElements.loginSection.classList.remove('hidden');
		DOMElements.managementSection.classList.add('hidden');
		DOMElements.loginPasswordInput.value = '';
	}

	function showManagementSection() {
		DOMElements.loginSection.classList.add('hidden');
		DOMElements.managementSection.classList.remove('hidden');

		// 加载所有数据
		loadTriggerKeys();
		loadFallbackKey();
		loadApiRetryLimit();
		loadGcpSettings();
		loadApiMappings();

		// 设置并加载 JSON 列表管理
		setupJsonListManagement({
			sectionPrefix: 'pool-keys', itemType: 'poolKey', itemName: '密钥池密钥',
			fetchEndpoint: '/pool-keys', saveEndpoint: '/pool-keys', clearEndpoint: '/pool-keys/all',
			dataKey: 'keys', bodyKey: 'keys'
		});
		setupJsonListManagement({
			sectionPrefix: 'fallback-models', itemType: 'fallbackModel', itemName: '回退模型',
			fetchEndpoint: '/fallback-models', saveEndpoint: '/fallback-models', clearEndpoint: '/fallback-models/all',
			dataKey: 'models', bodyKey: 'models'
		});
		 setupJsonListManagement({
			sectionPrefix: 'vertex-models', itemType: 'vertexModel', itemName: 'Vertex 模型',
			fetchEndpoint: '/vertex-models', saveEndpoint: '/vertex-models', clearEndpoint: '/vertex-models/all',
			dataKey: 'models', bodyKey: 'models'
		});
	}

	// --- 登录/登出事件 ---
	DOMElements.loginButton.onclick = async () => {
		const password = DOMElements.loginPasswordInput.value;
		if (!password) {
			showMessage('请输入密码。', 'error');
			return;
		}
		const result = await apiRequest('/login', 'POST', { password });
		if (result && result.success) {
			currentPassword = password;
			showMessage('登录成功!', 'success');
			showManagementSection();
		} else {
			DOMElements.loginPasswordInput.value = ''; // 登录失败清空
		}
	};

	DOMElements.logoutButton.onclick = () => {
		showMessage('已登出。', 'success');
		showLoginSection();
	};

	// --- 初始化 ---
	showLoginSection(); // 默认显示登录

}); // End DOMContentLoaded