import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, Menu, TFile, MenuItem, requestUrl } from 'obsidian';
import imageCompression from 'browser-image-compression';

// Remember to rename these classes and interfaces!

interface AliyunOssSettings {
	accessKeyId: string;
	accessKeySecret: string;
	bucket: string;
	region: string;
	customDomain: string;
	path: string;
	enableCompression: boolean;
	maxSizeMB: number;
	maxWidthOrHeight: number;
	interceptPasteAndDrop: boolean;
}

const DEFAULT_SETTINGS: AliyunOssSettings = {
	accessKeyId: '',
	accessKeySecret: '',
	bucket: '',
	region: '',
	customDomain: '',
	path: 'obsidian/',
	enableCompression: true,
	maxSizeMB: 0.3,
	maxWidthOrHeight: 1280,
	interceptPasteAndDrop: true
}

// 添加 OssService 类
class OssService {
	private settings: AliyunOssSettings;
	private maxRetries = 3;

	constructor(settings: AliyunOssSettings) {
		this.settings = settings;
	}

	private validateSettings(): void {
		if (!this.settings.accessKeyId) {
			throw new Error('缺少 Access Key ID');
		}
		if (!this.settings.accessKeySecret) {
			throw new Error('缺少 Access Key Secret');
		}
		if (!this.settings.bucket) {
			throw new Error('缺少 Bucket');
		}
		if (!this.settings.region) {
			throw new Error('缺少 Region');
		}
	}

	async retryOperation<T>(operation: () => Promise<T>, retryCount = 0): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (retryCount < this.maxRetries) {
				const delay = Math.pow(2, retryCount) * 1000; // 指数退避
				await new Promise(resolve => setTimeout(resolve, delay));
				return this.retryOperation(operation, retryCount + 1);
			}
			throw error;
		}
	}

	async generateSignature(ossPath: string, contentType: string): Promise<{ authorization: string; endpoint: string }> {
		const date = new Date().toUTCString();
		const ossResource = `/${this.settings.bucket}/${ossPath}`;
		const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossResource}`;
		
		const signature = await this.calculateSignature(stringToSign, this.settings.accessKeySecret);
		const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;
		const endpoint = `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com/${ossPath}`;

		return { authorization, endpoint };
	}

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

	async calculateHash(data: ArrayBuffer): Promise<string> {
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	async uploadWithCompression(
		fileContent: ArrayBuffer,
		fileName: string,
		options?: {
			onProgress?: (progress: number) => void,
			skipExistCheck?: boolean
		}
	): Promise<string> {
		const fileExt = fileName.split('.').pop() || '';
		const originalHash = await this.calculateHash(fileContent);
		const ossPath = `${this.settings.path}${originalHash}.${fileExt}`;

		// 检查文件是否已存在（除非明确跳过）
		if (!options?.skipExistCheck) {
			const fileExists = await this.checkFileExists(ossPath);
			if (fileExists) {
				const baseUrl = this.settings.customDomain || `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com`;
				return `${baseUrl}/${ossPath}`;
			}
		}

		let finalContent: ArrayBuffer = fileContent;
		
		// 如果启用了压缩，且文件是图片类型
		if (this.settings.enableCompression && /^(png|jpe?g|gif|webp|bmp)$/i.test(fileExt)) {
			const blob = new Blob([fileContent], { type: `image/${fileExt}` });
			const imageFile = new File([blob], fileName, { type: `image/${fileExt}` });
			
			const compressionOptions = {
				maxSizeMB: this.settings.maxSizeMB,
				maxWidthOrHeight: this.settings.maxWidthOrHeight,
				useWebWorker: true,
				onProgress: options?.onProgress
			};
			
			const compressedBlob = await imageCompression(imageFile, compressionOptions);
			finalContent = await compressedBlob.arrayBuffer();
		}

		const contentType = `image/${fileExt}`;
		const { authorization, endpoint } = await this.generateSignature(ossPath, contentType);

		await this.retryOperation(async () => {
			const response = await requestUrl({
				url: endpoint,
				method: 'PUT',
				headers: {
					'Authorization': authorization,
					'Date': new Date().toUTCString(),
					'Content-Type': contentType,
				},
				body: finalContent,
			});

			if (response.status !== 200) {
				throw new Error(`上传失败: HTTP ${response.status}`);
			}
		});

		const baseUrl = this.settings.customDomain || `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com`;
		return `${baseUrl}/${ossPath}`;
	}

	async uploadFile(fileContent: ArrayBuffer, fileName: string, progressCallback?: (progress: number) => void): Promise<string> {
		this.validateSettings();
		return this.uploadWithCompression(fileContent, fileName, {
			onProgress: progressCallback,
			skipExistCheck: false
		});
	}

	async checkFileExists(ossPath: string): Promise<boolean> {
		try {
			const endpoint = `https://${this.settings.bucket}.${this.settings.region}.aliyuncs.com/${ossPath}`;
			const date = new Date().toUTCString();
			const stringToSign = `HEAD\n\n\n${date}\n/${this.settings.bucket}/${ossPath}`;
			const signature = await this.calculateSignature(stringToSign, this.settings.accessKeySecret);
			const authorization = `OSS ${this.settings.accessKeyId}:${signature}`;

			const response = await requestUrl({
				url: endpoint,
				method: 'HEAD',
				headers: {
					'Authorization': authorization,
					'Date': date,
				},
			});

			return response.status === 200;
		} catch (error) {
			// 如果文件不存在，会返回 404
			if (error instanceof Error && error.message.includes('404')) {
				return false;
			}
			throw error;
		}
	}
}

export default class AliyunOssUploader extends Plugin {
	settings: AliyunOssSettings;
	private ossService: OssService;

	async onload() {
		await this.loadSettings();
		this.ossService = new OssService(this.settings);

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

		// 拦截粘贴事件
		this.registerEvent(
			this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor) => {
				if (!this.settings.interceptPasteAndDrop) return;

				const items = evt.clipboardData?.items;
				if (!items) return;

				for (const item of Array.from(items)) {
					if (item.type.startsWith('image/')) {
						evt.preventDefault();
						const blob = item.getAsFile();
						if (blob) {
							await this.handleImageUpload(blob);
						}
						break;
					}
				}
			})
		);

		// 拦截拖拽事件
		this.registerEvent(
			this.app.workspace.on('editor-drop', async (evt: DragEvent, editor: Editor) => {
				if (!this.settings.interceptPasteAndDrop) return;

				const items = evt.dataTransfer?.items;
				if (!items) return;

				for (const item of Array.from(items)) {
					if (item.type.startsWith('image/')) {
						evt.preventDefault();
						const blob = item.getAsFile();
						if (blob) {
							await this.handleImageUpload(blob);
						}
						break;
					}
				}
			})
		);

		// 添加设置选项卡
		this.addSettingTab(new AliyunOssSettingTab(this.app, this));
	}

	async uploadImage(file: TFile) {
		try {
			const progressNotice = new Notice('准备上传...', 0);
			
			if (!file || !(file instanceof TFile)) {
				throw new Error('无效的文件');
			}

			const arrayBuffer = await this.app.vault.readBinary(file);
			const imageUrl = await this.ossService.uploadWithCompression(arrayBuffer, file.name, {
				onProgress: (progress: number) => {
					progressNotice.setMessage(`处理进度: ${Math.round(progress)}%`);
				}
			});
			
			await this.updateMarkdown(file.name, imageUrl);
			progressNotice.hide();
			new Notice('上传成功！');
			
		} catch (error) {
			console.error('上传失败:', error);
			new Notice(`上传失败: ${error instanceof Error ? error.message : '未知错误'}`);
		}
	}

	private async updateMarkdown(fileName: string, imageUrl: string) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			await navigator.clipboard.writeText(imageUrl);
			return;
		}

		const editor = activeView.editor;
		const file = activeView.file;
		if (!file) return;
		const baseFileName = fileName.replace(/\.[^/.]+$/, "");

		// 使用 MetadataCache 获取所有嵌入图片的位置
		const cache = this.app.metadataCache.getFileCache(file);
		let replaced = false;

		if (cache?.embeds) {
			// 从后向前替换，以避免位置偏移问题
			for (let i = cache.embeds.length - 1; i >= 0; i--) {
				const embed = cache.embeds[i];
				if (embed.link === fileName) {
					const from = editor.offsetToPos(embed.position.start.offset);
					const to = editor.offsetToPos(embed.position.end.offset);
					editor.replaceRange(
						`![${baseFileName}](${imageUrl})`,
						from,
						to
					);
					replaced = true;
				}
			}
		}

		// 如果没有找到匹配的图片链接，则在光标位置插入新的链接
		if (!replaced) {
			const cursor = editor.getCursor();
			editor.replaceRange(`![${baseFileName}](${imageUrl})\n`, cursor);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async handleImageUpload(blob: File) {
		try {
			const progressNotice = new Notice('准备上传...', 0);
			
			const originalContent = await blob.arrayBuffer();
			const imageUrl = await this.ossService.uploadWithCompression(originalContent, blob.name, {
				onProgress: (progress: number) => {
					progressNotice.setMessage(`处理进度: ${Math.round(progress)}%`);
				}
			});

			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (activeView) {
				const editor = activeView.editor;
				const cursor = editor.getCursor();
				const baseFileName = blob.name.replace(/\.[^/.]+$/, "");
				editor.replaceRange(`![${baseFileName}](${imageUrl})\n`, cursor);
			}

			progressNotice.hide();
			new Notice('上传成功！');
		} catch (error) {
			console.error('上传失败:', error);
			new Notice(`上传失败: ${error instanceof Error ? error.message : '未知错误'}`);
		}
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
			.addText(text => {
				text.setPlaceholder('输入 Access Key Secret')
					.setValue(this.plugin.settings.accessKeySecret);
				text.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.accessKeySecret = value;
					await this.plugin.saveSettings();
				});
			});

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

		new Setting(containerEl)
			.setName('启用压缩')
			.setDesc('是否启用图片压缩')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableCompression)
				.onChange(async (value) => {
					this.plugin.settings.enableCompression = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('最大压缩尺寸')
			.setDesc('图片压缩的最大尺寸（像素）')
			.addText(text => text
				.setPlaceholder('例如：1920')
				.setValue(this.plugin.settings.maxWidthOrHeight.toString())
				.onChange(async (value) => {
					this.plugin.settings.maxWidthOrHeight = parseInt(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('压缩后最大文件大小')
			.setDesc('压缩后的最大文件大小（MB）')
			.addText(text => text
				.setPlaceholder('例如：1')
				.setValue(this.plugin.settings.maxSizeMB.toString())
				.onChange(async (value) => {
					this.plugin.settings.maxSizeMB = parseFloat(value);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('拦截粘贴和拖拽')
			.setDesc('启用后，粘贴或拖拽图片时将直接上传到阿里云 OSS，而不是保存到本地')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.interceptPasteAndDrop)
				.onChange(async (value) => {
					this.plugin.settings.interceptPasteAndDrop = value;
					await this.plugin.saveSettings();
				}));
	}
}