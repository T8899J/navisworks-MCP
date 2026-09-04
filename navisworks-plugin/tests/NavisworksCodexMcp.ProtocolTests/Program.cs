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
                TestWriteOversizedFrameIsRejected();
                TestSearchPageAtLimitRemainsResumable();
                TestScopeAllAdvancesFromNamesToProperties();
                TestEndpointRegistryKeepsInstancesIndependent();
                TestDocumentIdentityFollowsReadiness();
                Console.WriteLine("PROTOCOL_TESTS: PASS (8/8)");
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

        private static void TestWriteOversizedFrameIsRejected()
        {
            string oversized = new string('a', BridgeConstants.MaxFrameBytes + 1);

            using (var stream = new MemoryStream())
            {
                try
                {
                    BridgeFrameProtocol.WriteJsonAsync(
                        stream,
                        oversized,
                        CancellationToken.None).GetAwaiter().GetResult();
                }
                catch (BridgeException exception)
                {
                    Assert(
                        exception.Code == "FRAME_TOO_LARGE",
                        "Oversized write returned the wrong error.");
                    return;
                }
            }

            throw new InvalidOperationException(
                "Oversized write was not rejected.");
        }

        private static void TestSearchPageAtLimitRemainsResumable()
        {
            Assert(
                SearchContinuationPolicy.ShouldRetainSession(false),
                "A full page incorrectly discarded the search continuation.");
            Assert(
                SearchContinuationPolicy.ShouldResetPage(true, true),
                "A resumed full page did not reset its result buffer.");
            Assert(
                SearchContinuationPolicy.IsPageFull(100, 100),
                "The page did not stop exactly at its requested limit.");
        }

        private static void TestScopeAllAdvancesFromNamesToProperties()
        {
            Assert(
                SearchContinuationPolicy.ShouldAdvancePhase(1, 2),
                "scope=all stopped after the names phase.");
            Assert(
                !SearchContinuationPolicy.ShouldAdvancePhase(2, 2),
                "The search advanced past its final phase.");
        }

        private static void TestEndpointRegistryKeepsInstancesIndependent()
        {
            string dataDirectory = Path.Combine(
                Path.GetTempPath(),
                "navisworks-endpoints-" + Guid.NewGuid().ToString("N"));
            try
            {
                var first = new BridgeEndpointRegistry(dataDirectory, 12340);
                var second = new BridgeEndpointRegistry(dataDirectory, 18120);
                first.Write("pipe-a", "1.0.0", "2023");
                second.Write("pipe-b", "1.0.0", "2023");

                string endpoints = Path.Combine(dataDirectory, "endpoints");
                string firstFile = Path.Combine(endpoints, "12340.json");
                string secondFile = Path.Combine(endpoints, "18120.json");
                Assert(File.Exists(firstFile), "The first endpoint was overwritten.");
                Assert(File.Exists(secondFile), "The second endpoint was not written.");

                second.DeleteIfOwned("pipe-b");
                Assert(File.Exists(firstFile), "Deleting B removed A's endpoint.");
                Assert(!File.Exists(secondFile), "B did not remove its own endpoint.");
            }
            finally
            {
                if (Directory.Exists(dataDirectory))
                {
                    Directory.Delete(dataDirectory, true);
                }
            }
        }

        private static void TestDocumentIdentityFollowsReadiness()
        {
            // The reported bug: ActiveDocumentChanged fired while the document
            // was still clear, so the identity stayed null after the models
            // arrived. A readiness move on the same document must re-mint it.
            Assert(
                DocumentIdentityPolicy.ShouldResetIdentity(
                    sameDocumentObject: true,
                    documentHasModels: true,
                    hasIdentity: false),
                "A document that finished loading did not get an identity.");
            Assert(
                DocumentIdentityPolicy.ShouldResetIdentity(
                    sameDocumentObject: true,
                    documentHasModels: false,
                    hasIdentity: true),
                "A document that went clear kept a stale identity.");
            Assert(
                DocumentIdentityPolicy.ShouldResetIdentity(
                    sameDocumentObject: false,
                    documentHasModels: true,
                    hasIdentity: true),
                "A switched document did not reset its identity.");
            Assert(
                !DocumentIdentityPolicy.ShouldResetIdentity(
                    sameDocumentObject: true,
                    documentHasModels: true,
                    hasIdentity: true),
                "A steady loaded document re-minted its identity.");
            Assert(
                !DocumentIdentityPolicy.ShouldResetIdentity(
                    sameDocumentObject: true,
                    documentHasModels: false,
                    hasIdentity: false),
                "A steady no-document state triggered a spurious reset.");
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
