import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, Menu, TFile, MenuItem, requestUrl } from 'obsidian';

// Remember to rename these classes and interfaces!

interface AliyunOssSettings {
	accessKeyId: string;
	accessKeySecret: string;
	bucket: string;
	region: string;
	customDomain: string;
	path: string;
}

const DEFAULT_SETTINGS: AliyunOssSettings = {
	accessKeyId: '',
	accessKeySecret: '',
	bucket: '',
	region: '',
	customDomain: '',
	path: 'obsidian/'
}

export default class AliyunOssUploader extends Plugin {
	settings: AliyunOssSettings;

	async onload() {
		await this.loadSettings();

		// 添加右键菜单
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file: TFile) => {
				if (file instanceof TFile && file.extension.match(/png|jpg|jpeg|gif|bmp|webp/i)) {
					menu.addItem((item: MenuItem) => {
						item
							.setTitle('上传到阿里云 OSS')
							.setIcon('upload')
							.onClick(async () => {
								await this.uploadImage(file);
							});
					});
				}
			})
		);

		// 添加设置选项卡
		this.addSettingTab(new AliyunOssSettingTab(this.app, this));
	}

	async uploadImage(file: TFile) {
		try {
			if (!this.settings.accessKeyId || !this.settings.accessKeySecret || !this.settings.bucket || !this.settings.region) {
				new Notice('请先配置阿里云 OSS 信息');
				return;
			}

			console.log('开始处理文件:', file.name);
			const arrayBuffer = await this.app.vault.readBinary(file);
			const fileContent = arrayBuffer;
			console.log('文件内容读取成功，大小:', fileContent.byteLength, '字节');

			const fileName = file.name;
			const fileHash = await this.calculateHash(arrayBuffer);
			const fileExt = fileName.split('.').pop();
			const ossPath = `${this.settings.path}${fileHash}.${fileExt}`;
			console.log('准备上传到路径:', ossPath);

			// 构建 OSS 签名
			const date = new Date().toUTCString();
			const contentType = `image/${fileExt}`;
			const ossResource = `/${this.settings.bucket}/${ossPath}`;
			const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossResource}`;
			
			// 使用 CryptoJS 计算签名
			const signature = await this.calculateSignature(stringToSign, this.settings.accessKeySecret);
			
			const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;
			const endpoint = `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com/${ossPath}`;

			// 使用 Obsidian requestUrl 进行上传
			const response = await requestUrl({
				url: endpoint,
				method: 'PUT',
				headers: {
					'Authorization': authorization,
					'Date': date,
					'Content-Type': contentType,
				},
				body: fileContent,
			});

			if (response.status === 200) {
				const baseUrl = this.settings.customDomain || `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com`;
				const imageUrl = `${baseUrl}/${ossPath}`;

				// 获取当前打开的 markdown 文件
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					const editor = activeView.editor;
					const content = editor.getValue();
					// 更新正则表达式以更准确地匹配图片链接，包括 ![[]] 格式
					const filePath = file.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const imgRegex = new RegExp(`!\\[\\[${filePath}\\]\\]|!\\[([^\\]]*)\\]\\(${filePath}\\)`, 'g');
					
					// 提取原始文件名（不含扩展名）
					const baseFileName = fileName.replace(/\.[^/.]+$/, "");
					const newContent = content.replace(imgRegex, `![${baseFileName}](${imageUrl})`);
					
					if (content !== newContent) {
						editor.setValue(newContent);
						new Notice('图片上传成功并更新了链接！');
					} else {
						// 如果没有找到匹配的链接，尝试在光标位置插入新的图片链接
						const cursor = editor.getCursor();
						editor.replaceRange(`![${baseFileName}](${imageUrl})\n`, cursor);
						new Notice('图片上传成功并插入了新链接！');
					}
				} else {
					new Notice('图片上传成功！URL 已复制到剪贴板');
					await navigator.clipboard.writeText(imageUrl);
				}
			} else {
				throw new Error(`上传失败: ${response.status}`);
			}
		} catch (error) {
			console.error('上传失败:', error);
			new Notice('上传失败: ' + (error as Error).message);
		}
	}

	// 计算 OSS 签名
	private async calculateSignature(stringToSign: string, accessKeySecret: string): Promise<string> {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(accessKeySecret),
			{ name: 'HMAC', hash: 'SHA-1' },
			false,
			['sign']
		);
		const signature = await crypto.subtle.sign(
			'HMAC',
			key,
			encoder.encode(stringToSign)
		);
		return btoa(String.fromCharCode(...new Uint8Array(signature)));
	}

	// 使用 Web Crypto API 计算文件哈希
	private async calculateHash(data: ArrayBuffer): Promise<string> {
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return hashHex;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AliyunOssSettingTab extends PluginSettingTab {
	plugin: AliyunOssUploader;

	constructor(app: App, plugin: AliyunOssUploader) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: '阿里云 OSS 设置'});

		new Setting(containerEl)
			.setName('Access Key ID')
			.setDesc('阿里云账号的 Access Key ID')
			.addText(text => text
				.setPlaceholder('输入 Access Key ID')
				.setValue(this.plugin.settings.accessKeyId)
				.onChange(async (value) => {
					this.plugin.settings.accessKeyId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Access Key Secret')
			.setDesc('阿里云账号的 Access Key Secret')
			.addText(text => text
				.setPlaceholder('输入 Access Key Secret')
				.setValue(this.plugin.settings.accessKeySecret)
				.onChange(async (value) => {
					this.plugin.settings.accessKeySecret = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Bucket')
			.setDesc('OSS Bucket 名称')
			.addText(text => text
				.setPlaceholder('输入 Bucket 名称')
				.setValue(this.plugin.settings.bucket)
				.onChange(async (value) => {
					this.plugin.settings.bucket = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Region')
			.setDesc('OSS Region（地域）')
			.addText(text => text
				.setPlaceholder('例如：oss-cn-hangzhou')
				.setValue(this.plugin.settings.region)
				.onChange(async (value) => {
					this.plugin.settings.region = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('自定义域名')
			.setDesc('如果配置了 OSS 自定义域名，请在此输入（可选）')
			.addText(text => text
				.setPlaceholder('例如：https://images.example.com')
				.setValue(this.plugin.settings.customDomain)
				.onChange(async (value) => {
					this.plugin.settings.customDomain = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('存储路径')
			.setDesc('文件在 OSS 中的存储路径前缀')
			.addText(text => text
				.setPlaceholder('例如：obsidian/')
				.setValue(this.plugin.settings.path)
				.onChange(async (value) => {
					this.plugin.settings.path = value;
					await this.plugin.saveSettings();
				}));
	}
}
