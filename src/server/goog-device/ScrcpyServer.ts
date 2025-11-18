import '../../../vendor/Genymobile/scrcpy/scrcpy-server.jar';
import '../../../vendor/Genymobile/scrcpy/LICENSE';

import { Device } from './Device';
import { ARGS_STRING, SERVER_PACKAGE, SERVER_PROCESS_NAME, SERVER_VERSION } from '../../common/Constants';
import path from 'path';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { ServerVersion } from './ServerVersion';

const TEMP_PATH = '/data/local/tmp/';
const FILE_DIR = path.join(__dirname, 'vendor/Genymobile/scrcpy');
const FILE_NAME = 'scrcpy-server.jar';
const RUN_COMMAND = `CLASSPATH=${TEMP_PATH}${FILE_NAME} nohup app_process ${ARGS_STRING}`;
const MAX_PID_ATTEMPTS = 5;

type WaitForPidOptions = {
    abortSignal: AbortSignal;
    lookPidFile: boolean;
    maxAttempts?: number;
};

type PidFileCheckResult =
    | { status: 'found'; pids: number[] }
    | { status: 'stale' }
    | { status: 'missing' };

export class ScrcpyServer {
    private static PID_FILE_PATH = '/data/local/tmp/ws_scrcpy.pid';
    private static copyLocks: Map<string, Promise<void>> = new Map();

    private static async copyServer(device: Device): Promise<void> {
        const src = path.join(FILE_DIR, FILE_NAME);
        const dst = TEMP_PATH + FILE_NAME; // don't use path.join(): will not work on win host
        const transfer: PushTransfer = await device.push(src, dst);
        await new Promise<void>((resolve, reject) => {
            transfer.once('end', resolve);
            transfer.once('error', reject);
            transfer.once('cancel', () => reject(new Error('Push transfer cancelled')));
        });
    }

    private static async ensureServerCopied(device: Device): Promise<void> {
        const key = device.udid;
        const existing = this.copyLocks.get(key);
        if (existing) {
            return existing;
        }
        const copyPromise = this.copyServer(device).finally(() => {
            this.copyLocks.delete(key);
        });
        this.copyLocks.set(key, copyPromise);
        return copyPromise;
    }

    // Important to notice that we first try to read PID from file.
    // Checking with `.getServerPid()` will return process id, but process may stop.
    // PID file only created after WebSocket server has been successfully started.
    private static async waitForServerPid(device: Device, options: WaitForPidOptions): Promise<number[] | undefined> {
        let attempts = 0;
        let lookPidFile = options.lookPidFile;
        const maxAttempts = options.maxAttempts ?? MAX_PID_ATTEMPTS;
        while (!options.abortSignal.aborted) {
            if (lookPidFile) {
                const pidStatus = await this.checkPidFile(device);
                if (pidStatus.status === 'found') {
                    return pidStatus.pids;
                }
                if (pidStatus.status === 'stale') {
                    lookPidFile = false;
                }
            } else {
                const list = await this.getServerPid(device);
                if (Array.isArray(list) && list.length) {
                    return list;
                }
            }
            attempts++;
            if (attempts > maxAttempts) {
                throw new Error('Failed to start server');
            }
            await this.delay(500 + 100 * attempts, options.abortSignal);
        }
        return;
    }

    public static async getServerPid(device: Device): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        const list = await device.getPidOf(SERVER_PROCESS_NAME);
        if (!Array.isArray(list) || !list.length) {
            return;
        }
        const serverPid: number[] = [];
        const promises = list.map((pid) => {
            return device.runShellCommandAdbKit(`cat /proc/${pid}/cmdline`).then((output) => {
                const args = output.split('\0');
                if (!args.length || args[0] !== SERVER_PROCESS_NAME) {
                    return;
                }
                let first = args[0];
                while (args.length && first !== SERVER_PACKAGE) {
                    args.shift();
                    first = args[0];
                }
                if (args.length < 3) {
                    return;
                }
                const versionString = args[1];
                if (versionString === SERVER_VERSION) {
                    serverPid.push(pid);
                } else {
                    const currentVersion = new ServerVersion(versionString);
                    if (currentVersion.isCompatible()) {
                        const desired = new ServerVersion(SERVER_VERSION);
                        if (desired.gt(currentVersion)) {
                            console.log(
                                device.TAG,
                                `Found old server version running (PID: ${pid}, Version: ${versionString})`,
                            );
                            console.log(device.TAG, 'Perform kill now');
                            device.killProcess(pid);
                        }
                    }
                }
                return;
            });
        });
        await Promise.all(promises);
        return serverPid;
    }

    public static async run(device: Device): Promise<number[] | undefined> {
        if (!device.isConnected()) {
            return;
        }
        let list: number[] | string | undefined = await this.getServerPid(device);
        if (Array.isArray(list) && list.length) {
            return list;
        }
        await this.ensureServerCopied(device);

        const abortController = new AbortController();
        const waitPromise = this.waitForServerPid(device, {
            abortSignal: abortController.signal,
            lookPidFile: true,
            maxAttempts: MAX_PID_ATTEMPTS,
        });

        const runPromise = device
            .runShellCommandAdb(RUN_COMMAND)
            .then((out) => {
                if (device.isConnected()) {
                    console.log(device.TAG, 'Server exited:', out);
                }
                return out;
            })
            .catch((e) => {
                console.log(device.TAG, 'Error:', e.message);
                throw e;
            })
            .finally(() => {
                abortController.abort();
            });

        list = await Promise.race([waitPromise, runPromise]);
        abortController.abort();
        if (Array.isArray(list) && list.length) {
            return list;
        }
        return;
    }

    private static async checkPidFile(device: Device): Promise<PidFileCheckResult> {
        const fileName = ScrcpyServer.PID_FILE_PATH;
        try {
            const content = await device.runShellCommandAdbKit(`test -f ${fileName} && cat ${fileName}`);
            const trimmed = content.trim();
            if (!trimmed) {
                return { status: 'missing' };
            }
            const pid = parseInt(trimmed, 10);
            if (!pid || Number.isNaN(pid)) {
                return { status: 'missing' };
            }
            const realPid = await this.getServerPid(device);
            if (realPid?.includes(pid)) {
                return { status: 'found', pids: realPid };
            }
            return { status: 'stale' };
        } catch {
            return { status: 'missing' };
        }
    }

    private static async delay(ms: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted) {
            return;
        }
        await new Promise<void>((resolve) => {
            const timeoutId = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timeoutId);
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}
