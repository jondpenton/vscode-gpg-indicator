import * as vscode from 'vscode';

import * as git from './indicator/git';
import * as gpg from './indicator/gpg';
import * as process from './indicator/process';

function toFolders(folders: readonly vscode.WorkspaceFolder[]): string[] {
    return folders.map((folder: vscode.WorkspaceFolder) => folder.uri.path);
}

function getRefreshInterval(logger: Logger): number | undefined {
    const configuration = vscode.workspace.getConfiguration('gpgIndicator');
    if (!configuration) {
        logger.log('Can not retrieve configuration');
        return;
    }
    const syncStatusInterval = configuration.get('statusRefreshInterval');
    if (!syncStatusInterval || typeof syncStatusInterval !== 'number') {
        logger.log(`Unhandled value of refresh interval ${syncStatusInterval}`);
        return;
    }

    return syncStatusInterval;
}

export function activate(context: vscode.ExtensionContext) {
    const logger: Logger = new VscodeOutputLogger('GPG Indicator');
    const syncStatusInterval = getRefreshInterval(logger);
    if (!syncStatusInterval) {
        return;
    }
    logger.log('Active GPG Indicator extension ...');
    logger.log(`Setting: sync status interval: ${syncStatusInterval}`);

    const keyStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(keyStatusItem);

    logger.log('Create key status manager');
    const keyStatusManager = new KeyStatusManager(logger, syncStatusInterval);
    keyStatusManager.syncLoop();
    context.subscriptions.push(keyStatusManager);

    const commandId = 'gpgIndicator.unlockCurrentKey';
    const command = vscode.commands.registerCommand(commandId, async () => {
        const passphrase = await vscode.window.showInputBox({
            prompt: 'Input the passphrase for the signing key',
            password: true,
        });
        if (passphrase === undefined) { return; }
        try {
            await keyStatusManager.unlockCurrentKey(passphrase);
            vscode.window.showInformationMessage('Key unlocked.');
        } catch (err) {
            if (err instanceof Error) {
                vscode.window.showErrorMessage(`Failed to unlock: ${err.message}`);
            }
        }
    });
    context.subscriptions.push(command);
    keyStatusItem.tooltip = 'Unlock this key';
    keyStatusItem.command = commandId;

    if (vscode.workspace.workspaceFolders !== undefined) {
        const folders = toFolders(vscode.workspace.workspaceFolders);
        keyStatusManager.updateFolders(folders);
        keyStatusManager.changeActivateFolder(folders[0]);
    }

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        const syncStatusInterval = getRefreshInterval(logger);
        if (!syncStatusInterval) {
            return;
        }
        keyStatusManager.updateSyncInterval(syncStatusInterval);
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        const fileUri = editor?.document.uri;
        if (!fileUri) {
            return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        if (!folder) {
            return;
        }
        await keyStatusManager.changeActivateFolder(folder.uri.path);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
        if (vscode.workspace.workspaceFolders === undefined) {
            return;
        }
        const folders = toFolders(vscode.workspace.workspaceFolders);
        keyStatusManager.updateFolders(folders);
    }));

    keyStatusManager.registerUpdateFunction((event) => {
        const shortId = event.keyId.substr(event.keyId.length - 16);
        const lockIcon = event.isLocked ? 'lock' : 'unlock';
        const status = `$(${lockIcon}) ${shortId}`;
        const backgroundColor = event.isLocked
            ? new vscode.ThemeColor(`statusBarItem.warningBackground`)
            : undefined;
        keyStatusItem.text = status;
        keyStatusItem.backgroundColor = backgroundColor;
        keyStatusItem.show();
    });
}

export function deactivate() { }

class VscodeOutputLogger {
    #outputChannel: vscode.OutputChannel;
    /**
     * @param name - The name of VS Code output channel on UI
     */
    constructor(name: string) {
        this.#outputChannel = vscode.window.createOutputChannel(name);
    }

    log(message: string): void {
        this.#outputChannel.appendLine(message);
    }
}

/**
 * Logger is a sample interface for basic logging ability.
 */
interface Logger {
    /**
     * Log some message.
     * @param message - a message without ending new line
     */
    log(message: string): void
}

class KeyStatusEvent {
    keyId: string;
    isLocked: boolean;

    constructor(keyId: string, isLocked: boolean) {
        this.keyId = keyId;
        this.isLocked = isLocked;
    }

    static equal(left: KeyStatusEvent, right: KeyStatusEvent): boolean {
        return left.keyId === right.keyId && left.isLocked === right.isLocked;
    }
}

class KeyStatusManager {
    #activateFolder: string | undefined;
    #lastEvent: KeyStatusEvent | undefined;
    #keyOfFolders: Map<string, gpg.GpgKeyInfo> = new Map();
    #disposed: boolean = false;
    #updateFunctions: ((event: KeyStatusEvent) => void)[] = [];
    #logger: Logger;
    #syncInterval: number;

    /**
     * Construct the key status manager.
     *
     * @param logger - the output logger for debugging logs.
     * @param syncInterval - key status sync interval in seconds.
     */
    constructor(logger: Logger, syncInterval: number) {
        this.#logger = logger;
        this.#syncInterval = syncInterval;
    }

    async syncLoop(): Promise<void> {
        await process.sleep(1 * 1000);
        while (!this.#disposed) {
            if (this.#activateFolder) {
                await this.syncStatus();
            }
            await process.sleep(this.#syncInterval * 1000);
        }
        return;
    }

    updateSyncInterval(syncInterval: number): void {
        this.#syncInterval = syncInterval;
    }

    private async syncStatus(): Promise<void> {
        if (!this.#activateFolder) {
            return;
        }

        const keyInfo = this.#keyOfFolders.get(this.#activateFolder);
        if (keyInfo === undefined) {
            return;
        }

        let newEvent: KeyStatusEvent | undefined;
        try {
            const isUnlocked = await gpg.isKeyUnlocked(keyInfo.keygrip);
            newEvent = {
                keyId: keyInfo.fingerprint,
                isLocked: !isUnlocked,
            };
        } catch (err) {
            if (!(err instanceof Error)) {
                throw err;
            }
            this.#logger.log(`Fail to check key status: ${err.message}`);
        }

        if (newEvent === undefined) {
            return;
        } else if (this.#lastEvent === undefined) {
            this.#lastEvent = newEvent;
            this.notifyUpdate(newEvent);
        } else if (!KeyStatusEvent.equal(newEvent, this.#lastEvent)) {
            this.#lastEvent = newEvent;
            this.notifyUpdate(newEvent);
        }
    }

    private notifyUpdate(event: KeyStatusEvent): void {
        this.#logger.log(`New event, key: ${event.keyId}, is locked: ${event.isLocked}`);
        this.#logger.log('Trigger status update functions');
        for (const update of this.#updateFunctions) {
            update(event);
        }
    }

    // Update workspace folders
    async updateFolders(folders: string[]): Promise<void> {
        this.#logger.log('Update folder information');
        this.#keyOfFolders.clear();
        for (const folder of folders) {
            this.updateFolder(folder);
        }
    }

    private async updateFolder(folder: string): Promise<void> {
        try {
            const shouldParseKey = await git.isSigningActivated(folder);
            if (!shouldParseKey) {
                return;
            }
            const keyId = await git.getSigningKey(folder);
            const keyInfo = await gpg.getKeyInfo(keyId);
            this.#logger.log(`Find key ${keyInfo.fingerprint} for folder ${folder}`);
            this.#keyOfFolders.set(folder, keyInfo);
        } catch (err) {
            this.#logger.log(`Can not found key for folder: ${folder}`);
        }
        return;
    }

    // Change current key according to activate folder
    async changeActivateFolder(folder: string): Promise<void> {
        if (this.#activateFolder === folder) {
            return;
        }
        this.#logger.log(`Change folder to ${folder}`);
        this.#activateFolder = folder;
        await this.syncStatus();
    }

    registerUpdateFunction(update: (event: KeyStatusEvent) => void): void {
        this.#logger.log('Got one update function');
        this.#updateFunctions.push(update);
    }

    // Lock or unlock current key
    async unlockCurrentKey(passphrase: string): Promise<void> {
        if (this.#activateFolder === undefined) {
            throw new Error('No active folder');
        }

        const theKey = this.#keyOfFolders.get(this.#activateFolder);
        if (theKey === undefined) {
            throw new Error('No key for current folder');
        }

        await this.syncStatus();
        if (await gpg.isKeyUnlocked(theKey.keygrip)) {
            this.#logger.log(`Key is already unlocked, skip unlock request`);
            return;
        }

        this.#logger.log(`Try to unlock current key: ${theKey.fingerprint}`);
        await gpg.unlockByKey(this.#logger, theKey.keygrip, passphrase);
        await this.syncStatus();
    }

    // Stop sync key status loop
    dispose(): void {
        this.#disposed = true;
    }
}
