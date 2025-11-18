export {};

declare global {
    interface Window {
        MediaSource?: typeof MediaSource;
        VideoDecoder?: typeof VideoDecoder;
        EncodedVideoChunk?: typeof EncodedVideoChunk;
    }
}
