import '../style/app.css';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';
import { HostTracker } from './client/HostTracker';
import { Tool } from './client/Tool';

const globalWindow: Window | undefined = typeof window === 'undefined' ? undefined : window;
const MEDIA_SOURCE_H264_CODEC = 'video/mp4; codecs="avc1.42E01E"';

function warnPlayerSkip(playerName: string, reason: string): void {
    console.warn(`[PlayerGate] ${playerName} disabled: ${reason}`);
}

function supportsWebAssembly(): boolean {
    return typeof WebAssembly !== 'undefined';
}

function supportsMediaSource(): boolean {
    if (!globalWindow || typeof globalWindow.MediaSource === 'undefined') {
        return false;
    }
    const MediaSourceCtor = globalWindow.MediaSource;
    if (typeof MediaSourceCtor.isTypeSupported !== 'function') {
        return false;
    }
    return MediaSourceCtor.isTypeSupported(MEDIA_SOURCE_H264_CODEC);
}

function supportsTinyH264Decoder(): boolean {
    return supportsWebAssembly() && typeof Worker !== 'undefined';
}

function supportsWebCodecs(): boolean {
    if (!globalWindow) {
        return false;
    }
    const hasDecoder = typeof globalWindow.VideoDecoder === 'function';
    const hasChunk = typeof globalWindow.EncodedVideoChunk === 'function';
    return hasDecoder && hasChunk;
}

window.onload = async function (): Promise<void> {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    /// #if USE_BROADWAY
    if (supportsWebAssembly()) {
        const { BroadwayPlayer } = await import('./player/BroadwayPlayer');
        StreamClientScrcpy.registerPlayer(BroadwayPlayer);
    } else {
        warnPlayerSkip('Broadway', 'WebAssembly API not available');
    }
    /// #endif

    /// #if USE_H264_CONVERTER
    if (supportsMediaSource()) {
        const { MsePlayer } = await import('./player/MsePlayer');
        StreamClientScrcpy.registerPlayer(MsePlayer);
    } else {
        warnPlayerSkip('MSE', 'MediaSource Extensions + baseline H264 support not detected');
    }
    /// #endif

    /// #if USE_TINY_H264
    if (supportsTinyH264Decoder()) {
        const { TinyH264Player } = await import('./player/TinyH264Player');
        StreamClientScrcpy.registerPlayer(TinyH264Player);
    } else {
        warnPlayerSkip('TinyH264', 'WebAssembly or WebWorker APIs not available');
    }
    /// #endif

    /// #if USE_WEBCODECS
    if (supportsWebCodecs()) {
        const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
        StreamClientScrcpy.registerPlayer(WebCodecsPlayer);
    } else {
        warnPlayerSkip('WebCodecs', 'WebCodecs APIs not available');
    }
    /// #endif

    if (action === StreamClientScrcpy.ACTION && typeof parsedQuery.get('udid') === 'string') {
        StreamClientScrcpy.start(parsedQuery);
        return;
    }

    /// #if INCLUDE_APPL
    {
        const { DeviceTracker } = await import('./applDevice/client/DeviceTracker');

        /// #if USE_QVH_SERVER
        const { StreamClientQVHack } = await import('./applDevice/client/StreamClientQVHack');

        DeviceTracker.registerTool(StreamClientQVHack);

        /// #if USE_WEBCODECS
        if (supportsWebCodecs()) {
            const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
            StreamClientQVHack.registerPlayer(WebCodecsPlayer);
        } else {
            warnPlayerSkip('WebCodecs (QVHack)', 'WebCodecs APIs not available');
        }
        /// #endif

        /// #if USE_H264_CONVERTER
        if (supportsMediaSource()) {
            const { MsePlayerForQVHack } = await import('./player/MsePlayerForQVHack');
            StreamClientQVHack.registerPlayer(MsePlayerForQVHack);
        } else {
            warnPlayerSkip('MSE (QVHack)', 'MediaSource Extensions + baseline H264 support not detected');
        }
        /// #endif

        if (action === StreamClientQVHack.ACTION && typeof parsedQuery.get('udid') === 'string') {
            StreamClientQVHack.start(StreamClientQVHack.parseParameters(parsedQuery));
            return;
        }
        /// #endif

        /// #if USE_WDA_MJPEG_SERVER
        const { StreamClientMJPEG } = await import('./applDevice/client/StreamClientMJPEG');
        DeviceTracker.registerTool(StreamClientMJPEG);

        const { MjpegPlayer } = await import('./player/MjpegPlayer');
        StreamClientMJPEG.registerPlayer(MjpegPlayer);

        if (action === StreamClientMJPEG.ACTION && typeof parsedQuery.get('udid') === 'string') {
            StreamClientMJPEG.start(StreamClientMJPEG.parseParameters(parsedQuery));
            return;
        }
        /// #endif
    }
    /// #endif

    const tools: Tool[] = [];

    /// #if INCLUDE_ADB_SHELL
    const { ShellClient } = await import('./googDevice/client/ShellClient');
    if (action === ShellClient.ACTION && typeof parsedQuery.get('udid') === 'string') {
        ShellClient.start(ShellClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(ShellClient);
    /// #endif

    /// #if INCLUDE_DEV_TOOLS
    const { DevtoolsClient } = await import('./googDevice/client/DevtoolsClient');
    if (action === DevtoolsClient.ACTION) {
        DevtoolsClient.start(DevtoolsClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(DevtoolsClient);
    /// #endif

    /// #if INCLUDE_FILE_LISTING
    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    if (action === FileListingClient.ACTION) {
        FileListingClient.start(FileListingClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(FileListingClient);
    /// #endif

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }
    HostTracker.start();
};
