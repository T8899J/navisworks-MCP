namespace NavisworksCodexMcp.Plugin
{
    internal static class DocumentIdentityPolicy
    {
        // ActiveDocumentChanged fires while the document is still clear, and
        // no second event fires once the models arrive. The document identity
        // must therefore track readiness moves seen between tool calls, not
        // latch onto whatever the state was at event time.
        internal static bool ShouldResetIdentity(
            bool sameDocumentObject,
            bool documentHasModels,
            bool hasIdentity)
        {
            if (!sameDocumentObject)
            {
                return true;
            }

            return documentHasModels != hasIdentity;
        }
    }
}
