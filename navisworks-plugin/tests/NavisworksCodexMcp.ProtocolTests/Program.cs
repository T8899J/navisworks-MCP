using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace NavisworksCodexMcp.Plugin
{
    internal static class Program
    {
        private static int Main()
        {
            try
            {
                TestRequestSerialization();
                TestFrameRoundTrip();
                TestOversizedFrameIsRejected();
                Console.WriteLine("PROTOCOL_TESTS: PASS (3/3)");
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    "PROTOCOL_TESTS: FAIL - " + exception.Message);
                return 1;
            }
        }

        private static void TestRequestSerialization()
        {
            var serializer = new JavaScriptSerializer();
            var request = new BridgeRequest
            {
                Id = "request-1",
                ProtocolVersion = 1,
                Method = "navisworks_status",
                Params = new Dictionary<string, object>
                {
                    { "enabled", true }
                }
            };

            string json = serializer.Serialize(request);
            BridgeRequest restored = serializer.Deserialize<BridgeRequest>(json);

            Assert(restored.Id == request.Id, "Request ID was not preserved.");
            Assert(
                restored.ProtocolVersion == 1,
                "Protocol version was not preserved.");
            Assert(
                restored.Method == request.Method,
                "Method was not preserved.");
        }

        private static void TestFrameRoundTrip()
        {
            const string Json = "{\"Ok\":true,\"Result\":{\"answer\":42}}";
            using (var stream = new MemoryStream())
            {
                BridgeFrameProtocol.WriteJsonAsync(
                    stream,
                    Json,
                    CancellationToken.None).GetAwaiter().GetResult();
                stream.Position = 0;
                string restored = BridgeFrameProtocol.ReadJsonAsync(
                    stream,
                    CancellationToken.None).GetAwaiter().GetResult();
                Assert(restored == Json, "Frame round trip changed the payload.");
            }
        }

        private static void TestOversizedFrameIsRejected()
        {
            byte[] invalidHeader =
            {
                1,
                0,
                16,
                0
            };

            using (var stream = new MemoryStream(invalidHeader))
            {
                try
                {
                    BridgeFrameProtocol.ReadJsonAsync(
                        stream,
                        CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (BridgeException exception)
                {
                    Assert(
                        exception.Code == "INVALID_FRAME_LENGTH",
                        "Oversized frame returned the wrong error.");
                    return;
                }
            }

            throw new InvalidOperationException(
                "Oversized frame was not rejected.");
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException(message);
            }
        }
    }
}

