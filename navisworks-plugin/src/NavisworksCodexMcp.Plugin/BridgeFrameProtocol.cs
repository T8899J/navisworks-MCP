using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace NavisworksCodexMcp.Plugin
{
    internal static class BridgeFrameProtocol
    {
        public static async Task<string> ReadJsonAsync(
            Stream stream,
            CancellationToken cancellationToken)
        {
            byte[] header = new byte[4];
            bool hasFrame = await ReadExactlyAsync(
                stream,
                header,
                true,
                cancellationToken).ConfigureAwait(false);

            if (!hasFrame)
            {
                return null;
            }

            int payloadLength =
                header[0]
                | (header[1] << 8)
                | (header[2] << 16)
                | (header[3] << 24);

            if (payloadLength <= 0 || payloadLength > BridgeConstants.MaxFrameBytes)
            {
                throw new BridgeException(
                    "INVALID_FRAME_LENGTH",
                    "Bridge frame length is outside the allowed range.");
            }

            byte[] payload = new byte[payloadLength];
            await ReadExactlyAsync(
                stream,
                payload,
                false,
                cancellationToken).ConfigureAwait(false);

            return new UTF8Encoding(false, true).GetString(payload);
        }

        public static async Task WriteJsonAsync(
            Stream stream,
            string json,
            CancellationToken cancellationToken)
        {
            if (json == null)
            {
                throw new ArgumentNullException("json");
            }

            byte[] payload = new UTF8Encoding(false, true).GetBytes(json);
            if (payload.Length > BridgeConstants.MaxFrameBytes)
            {
                throw new BridgeException(
                    "FRAME_TOO_LARGE",
                    "Bridge response exceeds the one MiB protocol limit.");
            }

            byte[] header =
            {
                (byte)(payload.Length & 0xff),
                (byte)((payload.Length >> 8) & 0xff),
                (byte)((payload.Length >> 16) & 0xff),
                (byte)((payload.Length >> 24) & 0xff)
            };

            await stream.WriteAsync(
                header,
                0,
                header.Length,
                cancellationToken).ConfigureAwait(false);
            await stream.WriteAsync(
                payload,
                0,
                payload.Length,
                cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        private static async Task<bool> ReadExactlyAsync(
            Stream stream,
            byte[] buffer,
            bool allowEndOfStream,
            CancellationToken cancellationToken)
        {
            int offset = 0;

            while (offset < buffer.Length)
            {
                int bytesRead = await stream.ReadAsync(
                    buffer,
                    offset,
                    buffer.Length - offset,
                    cancellationToken).ConfigureAwait(false);

                if (bytesRead == 0)
                {
                    if (allowEndOfStream && offset == 0)
                    {
                        return false;
                    }

                    throw new EndOfStreamException(
                        "Bridge connection ended in the middle of a frame.");
                }

                offset += bytesRead;
            }

            return true;
        }
    }
}

