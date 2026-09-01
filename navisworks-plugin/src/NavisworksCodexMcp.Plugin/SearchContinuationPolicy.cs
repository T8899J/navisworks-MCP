namespace NavisworksCodexMcp.Plugin
{
    internal static class SearchContinuationPolicy
    {
        internal static bool ShouldRetainSession(bool complete)
        {
            return !complete;
        }

        internal static bool ShouldResetPage(bool pageFull, bool resumed)
        {
            return pageFull && resumed;
        }

        internal static bool IsPageFull(int matchCount, int limit)
        {
            return matchCount >= limit;
        }

        internal static bool ShouldAdvancePhase(int nextPhaseIndex, int phaseCount)
        {
            return nextPhaseIndex < phaseCount;
        }
    }
}
