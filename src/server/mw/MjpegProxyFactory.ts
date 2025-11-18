import { Request, Response } from 'express';
import MjpegProxy from 'node-mjpeg-proxy';
import { WdaRunner } from '../appl-device/services/WDARunner';
import { WdaStatus } from '../../common/WdaStatus';

const WAIT_FOR_WDA_START_MS = 20000;

export class MjpegProxyFactory {
    private static instances: Map<string, MjpegProxy> = new Map();
    proxyRequest = async (req: Request, res: Response): Promise<void> => {
        const { udid } = req.params;
        if (!udid) {
            res.destroy();
            return;
        }
        let proxy = MjpegProxyFactory.instances.get(udid);
        if (!proxy) {
            const wda = await WdaRunner.getInstance(udid);
            try {
                if (!wda.isStarted()) {
                    await this.waitForWdaStart(wda);
                }
                const port = wda.mjpegPort;
                const url = `http://127.0.0.1:${port}`;
                proxy = new MjpegProxy(url);
                proxy.on('streamstop', (): void => {
                    wda.release();
                    MjpegProxyFactory.instances.delete(udid);
                });
                proxy.on('error', (data: { msg: Error; url: string }): void => {
                    console.error('msg: ' + data.msg);
                    console.error('url: ' + data.url);
                });
                MjpegProxyFactory.instances.set(udid, proxy);
            } catch (error) {
                wda.release();
                throw error;
            }
        }
        proxy.proxyRequest(req, res);
    };

    private async waitForWdaStart(wda: WdaRunner): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            if (wda.isStarted()) {
                resolve();
                return;
            }

            const cleanup = (): void => {
                wda.off('status-change', onStatusChange);
                wda.off('error', onError);
                clearTimeout(timeoutId);
            };

            const onStatusChange = ({ status }: { status: WdaStatus }) => {
                if (status === WdaStatus.STARTED) {
                    cleanup();
                    resolve();
                } else if (status === WdaStatus.STOPPED) {
                    cleanup();
                    reject(new Error('WebDriverAgent stopped before MJPEG stream became available'));
                }
            };

            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Timed out waiting for WebDriverAgent MJPEG server to start'));
            }, WAIT_FOR_WDA_START_MS);

            wda.on('status-change', onStatusChange);
            wda.on('error', onError);

            wda.start().catch((error) => {
                cleanup();
                reject(error);
            });
        });
    }
}
