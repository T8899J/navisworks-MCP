using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using Autodesk.Navisworks.Api;

namespace NavisworksCodexMcp.Plugin
{
    internal sealed class NavisworksToolService
    {
        private const int MaxCachedItems = 5000;
        private const int MaxPropertiesPerItem = 250;
        private const int MaxSearchScannedItems = 100000;
        private const int MaxSearchMilliseconds = 5000;
        private const int MaxViewpointEntries = 500;
        private const int MaxTextLength = 1000;

        private readonly Dictionary<string, ModelItem> itemCache =
            new Dictionary<string, ModelItem>(StringComparer.Ordinal);
        private readonly Queue<string> itemOrder = new Queue<string>();
        private Document cachedDocument;
        private int cacheGeneration = 1;
        private int itemSequence;

        public object Execute(
            string method,
            Dictionary<string, object> parameters)
        {
            EnsureDocumentState();

            switch (method)
            {
                case "navisworks_status":
                    return GetStatus();
                case "navisworks_get_document":
                    return GetDocument();
                case "navisworks_get_selection":
                    return GetSelection(parameters);
                case "navisworks_find_items":
                    return FindItems(parameters);
                case "navisworks_get_item_properties":
                    return GetItemProperties(parameters);
                case "navisworks_select_items":
                    return SelectItems(parameters);
                case "navisworks_set_visibility":
                    return SetVisibility(parameters);
                case "navisworks_list_viewpoints":
                    return ListViewpoints();
                case "navisworks_activate_viewpoint":
                    return ActivateViewpoint(parameters);
                default:
                    throw new BridgeException(
                        "UNKNOWN_METHOD",
                        "The requested Navisworks method is not available.");
            }
        }

        public void ResetSessionState()
        {
            itemCache.Clear();
            itemOrder.Clear();
            itemSequence = 0;
            cacheGeneration++;
            cachedDocument = Application.ActiveDocument;
        }

        private object GetStatus()
        {
            Document document = Application.ActiveDocument;
            var result = new Dictionary<string, object>
            {
                { "connected", true },
                { "product", "Autodesk Navisworks Manage" },
                { "hostApiMajor", Application.Version.ApiMajor },
                { "hostRuntimeMajor", Application.Version.RuntimeMajor },
                { "hostRuntimeMinor", Application.Version.RuntimeMinor },
                { "processId", Process.GetCurrentProcess().Id },
                { "hasDocument", document != null && !document.IsClear },
                { "sessionGeneration", cacheGeneration }
            };

            if (document != null)
            {
                result["documentTitle"] = LimitText(document.Title);
                result["documentFileName"] = LimitText(document.FileName);
            }

            return result;
        }

        private object GetDocument()
        {
            Document document = RequireDocument();
            var models = new List<object>();
            int index = 0;

            foreach (Model model in document.Models)
            {
                models.Add(new Dictionary<string, object>
                {
                    { "index", index },
                    { "fileName", LimitText(model.FileName) },
                    { "sourceFileName", LimitText(model.SourceFileName) },
                    { "guid", model.Guid.ToString("D") },
                    { "units", model.Units.ToString() },
                    { "isReadOnly", model.IsReadOnly }
                });
                index++;
            }

            return new Dictionary<string, object>
            {
                { "title", LimitText(document.Title) },
                { "fileName", LimitText(document.FileName) },
                { "currentFileName", LimitText(document.CurrentFileName) },
                { "units", document.Units.ToString() },
                { "isClear", document.IsClear },
                { "isModified", document.IsModified },
                { "modelCount", document.Models.Count },
                { "models", models },
                { "selectionCount", document.CurrentSelection.SelectedItems.Count },
                { "savedViewpointCount", CountSavedViewpoints(document) }
            };
        }

        private object GetSelection(Dictionary<string, object> parameters)
        {
            Document document = RequireDocument();
            bool includeProperties = GetBoolean(
                parameters,
                "includeProperties",
                false);
            int limit = GetInteger(parameters, "limit", 50, 1, 100);
            ModelItemCollection selectedItems =
                document.CurrentSelection.SelectedItems;
            var items = new List<object>();
            int index = 0;

            foreach (ModelItem item in selectedItems)
            {
                if (index >= limit)
                {
                    break;
                }

                string itemId = RegisterItem(item);
                Dictionary<string, object> summary = SummarizeItem(item, itemId);
                if (includeProperties)
                {
                    summary["propertyData"] = SerializeProperties(
                        item,
                        null,
                        null);
                }

                items.Add(summary);
                index++;
            }

            return new Dictionary<string, object>
            {
                { "selectedCount", selectedItems.Count },
                { "returnedCount", items.Count },
                { "truncated", selectedItems.Count > items.Count },
                { "items", items }
            };
        }

        private object FindItems(Dictionary<string, object> parameters)
        {
            Document document = RequireDocument();
            string query = GetRequiredString(parameters, "query", 200);
            string scope = GetChoice(
                parameters,
                "scope",
                "names",
                "names",
                "properties",
                "all");
            string category = GetOptionalString(parameters, "category", 200);
            string property = GetOptionalString(parameters, "property", 200);
            string matchMode = GetChoice(
                parameters,
                "match",
                "contains",
                "contains",
                "equals");
            bool caseSensitive = GetBoolean(
                parameters,
                "caseSensitive",
                false);
            int limit = GetInteger(parameters, "limit", 50, 1, 100);
            bool searchNames = scope == "names" || scope == "all";
            bool searchProperties =
                scope == "properties"
                || scope == "all"
                || category != null
                || property != null;

            var stopwatch = Stopwatch.StartNew();
            var items = new List<object>();
            int scannedCount = 0;
            bool timedOut = false;
            bool scanLimitReached = false;
            bool resultLimitReached = false;

            foreach (ModelItem item in document.Models.RootItemDescendantsAndSelf)
            {
                scannedCount++;

                if (scannedCount > MaxSearchScannedItems)
                {
                    scanLimitReached = true;
                    break;
                }

                if ((scannedCount & 255) == 0
                    && stopwatch.ElapsedMilliseconds > MaxSearchMilliseconds)
                {
                    timedOut = true;
                    break;
                }

                Dictionary<string, object> match = FindMatch(
                    item,
                    query,
                    searchNames,
                    searchProperties,
                    category,
                    property,
                    matchMode,
                    caseSensitive);
                if (match == null)
                {
                    continue;
                }

                string itemId = RegisterItem(item);
                Dictionary<string, object> summary = SummarizeItem(item, itemId);
                summary["match"] = match;
                items.Add(summary);

                if (items.Count >= limit)
                {
                    resultLimitReached = true;
                    break;
                }
            }

            stopwatch.Stop();
            return new Dictionary<string, object>
            {
                { "query", query },
                { "returnedCount", items.Count },
                { "scannedCount", scannedCount },
                { "elapsedMilliseconds", stopwatch.ElapsedMilliseconds },
                {
                    "truncated",
                    timedOut || scanLimitReached || resultLimitReached
                },
                { "timedOut", timedOut },
                { "scanLimitReached", scanLimitReached },
                { "items", items }
            };
        }

        private object GetItemProperties(Dictionary<string, object> parameters)
        {
            RequireDocument();
            List<string> itemIds = GetStringList(
                parameters,
                "itemIds",
                1,
                50);
            string category = GetOptionalString(parameters, "category", 200);
            string property = GetOptionalString(parameters, "property", 200);
            var results = new List<object>();

            foreach (string itemId in itemIds)
            {
                ModelItem item = ResolveItem(itemId);
                results.Add(new Dictionary<string, object>
                {
                    { "item", SummarizeItem(item, itemId) },
                    {
                        "propertyData",
                        SerializeProperties(item, category, property)
                    }
                });
            }

            return new Dictionary<string, object>
            {
                { "itemCount", results.Count },
                { "items", results }
            };
        }

        private object SelectItems(Dictionary<string, object> parameters)
        {
            Document document = RequireDocument();
            string mode = GetChoice(
                parameters,
                "mode",
                "replace",
                "replace",
                "add",
                "remove",
                "clear");

            if (mode == "clear")
            {
                document.CurrentSelection.Clear();
                return SelectionResult(document, mode, 0);
            }

            List<string> itemIds = GetStringList(
                parameters,
                "itemIds",
                1,
                50);
            ModelItemCollection items = ResolveItemCollection(itemIds);

            switch (mode)
            {
                case "replace":
                    document.CurrentSelection.CopyFrom(items);
                    break;
                case "add":
                    document.CurrentSelection.AddRange(items);
                    break;
                case "remove":
                    foreach (ModelItem item in items)
                    {
                        document.CurrentSelection.Remove(item);
                    }

                    break;
            }

            return SelectionResult(document, mode, items.Count);
        }

        private object SetVisibility(Dictionary<string, object> parameters)
        {
            Document document = RequireDocument();
            string action = GetChoice(
                parameters,
                "action",
                null,
                "hide",
                "show",
                "isolate",
                "reset");

            if (action == "reset")
            {
                document.Models.ResetAllHidden();
                return new Dictionary<string, object>
                {
                    { "action", action },
                    { "affectedItemCount", 0 },
                    { "hiddenStateReset", true }
                };
            }

            List<string> itemIds = GetStringList(
                parameters,
                "itemIds",
                1,
                50);
            ModelItemCollection items = ResolveItemCollection(itemIds);

            if (action == "hide")
            {
                document.Models.SetHidden(items, true);
            }
            else if (action == "show")
            {
                document.Models.SetHidden(items, false);
            }
            else
            {
                items.Minimize();
                var hiddenItems = new ModelItemCollection(items);
                hiddenItems.Invert(document);
                document.Models.SetHidden(hiddenItems, true);
                document.Models.SetHidden(items, false);
            }

            return new Dictionary<string, object>
            {
                { "action", action },
                { "affectedItemCount", items.Count },
                { "hiddenStateReset", false }
            };
        }

        private object ListViewpoints()
        {
            Document document = RequireDocument();
            var entries = new List<object>();
            bool truncated = false;

            AppendSavedItems(
                document.SavedViewpoints.RootItem.Children,
                string.Empty,
                entries,
                ref truncated);

            return new Dictionary<string, object>
            {
                { "returnedCount", entries.Count },
                { "truncated", truncated },
                { "entries", entries }
            };
        }

        private object ActivateViewpoint(Dictionary<string, object> parameters)
        {
            Document document = RequireDocument();
            string viewpointId = GetRequiredString(
                parameters,
                "viewpointId",
                36);
            Guid viewpointGuid;

            if (!Guid.TryParse(viewpointId, out viewpointGuid))
            {
                throw new BridgeException(
                    "INVALID_VIEWPOINT_ID",
                    "viewpointId must be a GUID.");
            }

            SavedItem savedItem =
                document.SavedViewpoints.ResolveGuid(viewpointGuid);
            var savedViewpoint = savedItem as SavedViewpoint;
            if (savedViewpoint == null)
            {
                throw new BridgeException(
                    "VIEWPOINT_NOT_FOUND",
                    "The saved viewpoint does not exist in the active document.");
            }

            document.SavedViewpoints.CurrentSavedViewpoint = savedViewpoint;
            return new Dictionary<string, object>
            {
                { "activated", true },
                { "viewpointId", savedViewpoint.Guid.ToString("D") },
                { "displayName", LimitText(savedViewpoint.DisplayName) }
            };
        }

        private static object SelectionResult(
            Document document,
            string mode,
            int requestedItemCount)
        {
            return new Dictionary<string, object>
            {
                { "mode", mode },
                { "requestedItemCount", requestedItemCount },
                {
                    "selectedCount",
                    document.CurrentSelection.SelectedItems.Count
                }
            };
        }

        private Dictionary<string, object> FindMatch(
            ModelItem item,
            string query,
            bool searchNames,
            bool searchProperties,
            string categoryFilter,
            string propertyFilter,
            string matchMode,
            bool caseSensitive)
        {
            try
            {
                if (searchNames)
                {
                    Dictionary<string, object> nameMatch = MatchName(
                        item,
                        query,
                        matchMode,
                        caseSensitive);
                    if (nameMatch != null)
                    {
                        return nameMatch;
                    }
                }

                if (!searchProperties)
                {
                    return null;
                }

                foreach (PropertyCategory category in item.PropertyCategories)
                {
                    if (!MatchesFilter(
                        categoryFilter,
                        category.DisplayName,
                        category.Name))
                    {
                        continue;
                    }

                    foreach (DataProperty property in category.Properties)
                    {
                        if (!MatchesFilter(
                            propertyFilter,
                            property.DisplayName,
                            property.Name))
                        {
                            continue;
                        }

                        string value = GetDisplayValue(property);
                        if (MatchesText(
                            value,
                            query,
                            matchMode,
                            caseSensitive))
                        {
                            return new Dictionary<string, object>
                            {
                                { "source", "property" },
                                {
                                    "category",
                                    LimitText(category.DisplayName)
                                },
                                {
                                    "property",
                                    LimitText(property.DisplayName)
                                },
                                { "value", LimitText(value) }
                            };
                        }
                    }
                }
            }
            catch
            {
                // One invalid model item must not abort a bounded search.
            }

            return null;
        }

        private static Dictionary<string, object> MatchName(
            ModelItem item,
            string query,
            string matchMode,
            bool caseSensitive)
        {
            var names = new[]
            {
                new KeyValuePair<string, string>(
                    "displayName",
                    item.DisplayName),
                new KeyValuePair<string, string>(
                    "classDisplayName",
                    item.ClassDisplayName),
                new KeyValuePair<string, string>(
                    "className",
                    item.ClassName)
            };

            foreach (KeyValuePair<string, string> name in names)
            {
                if (MatchesText(
                    name.Value,
                    query,
                    matchMode,
                    caseSensitive))
                {
                    return new Dictionary<string, object>
                    {
                        { "source", name.Key },
                        { "value", LimitText(name.Value) }
                    };
                }
            }

            return null;
        }

        private Dictionary<string, object> SummarizeItem(
            ModelItem item,
            string itemId)
        {
            var result = new Dictionary<string, object>
            {
                { "itemId", itemId },
                { "displayName", LimitText(item.DisplayName) },
                { "classDisplayName", LimitText(item.ClassDisplayName) },
                { "className", LimitText(item.ClassName) },
                { "instanceGuid", item.InstanceGuid.ToString("D") },
                { "isHidden", item.IsHidden },
                { "hasGeometry", item.HasGeometry },
                { "isCollection", item.IsCollection },
                { "isLayer", item.IsLayer }
            };

            if (item.Parent != null)
            {
                result["parentDisplayName"] = LimitText(
                    item.Parent.DisplayName);
            }

            if (item.HasModel && item.Model != null)
            {
                result["modelFileName"] = LimitText(item.Model.FileName);
            }

            return result;
        }

        private static object SerializeProperties(
            ModelItem item,
            string categoryFilter,
            string propertyFilter)
        {
            var categories = new List<object>();
            int propertyCount = 0;
            bool truncated = false;

            foreach (PropertyCategory category in item.PropertyCategories)
            {
                if (!MatchesFilter(
                    categoryFilter,
                    category.DisplayName,
                    category.Name))
                {
                    continue;
                }

                var properties = new List<object>();
                foreach (DataProperty property in category.Properties)
                {
                    if (!MatchesFilter(
                        propertyFilter,
                        property.DisplayName,
                        property.Name))
                    {
                        continue;
                    }

                    if (propertyCount >= MaxPropertiesPerItem)
                    {
                        truncated = true;
                        break;
                    }

                    properties.Add(new Dictionary<string, object>
                    {
                        { "name", LimitText(property.Name) },
                        { "displayName", LimitText(property.DisplayName) },
                        { "dataType", property.Value.DataType.ToString() },
                        { "value", LimitText(GetDisplayValue(property)) }
                    });
                    propertyCount++;
                }

                if (properties.Count > 0)
                {
                    categories.Add(new Dictionary<string, object>
                    {
                        { "name", LimitText(category.Name) },
                        { "displayName", LimitText(category.DisplayName) },
                        { "properties", properties }
                    });
                }

                if (truncated)
                {
                    break;
                }
            }

            return new Dictionary<string, object>
            {
                { "propertyCount", propertyCount },
                { "truncated", truncated },
                { "categories", categories }
            };
        }

        private static string GetDisplayValue(DataProperty property)
        {
            try
            {
                return property.Value == null
                    ? string.Empty
                    : property.Value.ToDisplayString();
            }
            catch
            {
                return string.Empty;
            }
        }

        private string RegisterItem(ModelItem item)
        {
            while (itemCache.Count >= MaxCachedItems
                && itemOrder.Count > 0)
            {
                string oldestItemId = itemOrder.Dequeue();
                itemCache.Remove(oldestItemId);
            }

            itemSequence++;
            string itemId = string.Format(
                "item-{0}-{1}",
                cacheGeneration,
                itemSequence);
            itemCache[itemId] = item;
            itemOrder.Enqueue(itemId);
            return itemId;
        }

        private ModelItem ResolveItem(string itemId)
        {
            ModelItem item;
            if (!itemCache.TryGetValue(itemId, out item) || item == null)
            {
                throw new BridgeException(
                    "STALE_ITEM_ID",
                    "A Navisworks item ID is unknown or stale. Query the model again.");
            }

            return item;
        }

        private ModelItemCollection ResolveItemCollection(
            IEnumerable<string> itemIds)
        {
            var items = new ModelItemCollection();
            foreach (string itemId in itemIds)
            {
                items.Add(ResolveItem(itemId));
            }

            return items;
        }

        private void EnsureDocumentState()
        {
            Document currentDocument = Application.ActiveDocument;
            if (!ReferenceEquals(currentDocument, cachedDocument))
            {
                ResetSessionState();
            }
        }

        private static Document RequireDocument()
        {
            Document document = Application.ActiveDocument;
            if (document == null || document.IsClear)
            {
                throw new BridgeException(
                    "NO_DOCUMENT",
                    "No Navisworks document is open.");
            }

            return document;
        }

        private static int CountSavedViewpoints(Document document)
        {
            int count = 0;
            CountSavedViewpoints(
                document.SavedViewpoints.RootItem.Children,
                ref count);
            return count;
        }

        private static void CountSavedViewpoints(
            SavedItemCollection items,
            ref int count)
        {
            foreach (SavedItem item in items)
            {
                if (item is SavedViewpoint)
                {
                    count++;
                }

                var group = item as GroupItem;
                if (group != null)
                {
                    CountSavedViewpoints(group.Children, ref count);
                }
            }
        }

        private static void AppendSavedItems(
            SavedItemCollection items,
            string parentPath,
            List<object> entries,
            ref bool truncated)
        {
            foreach (SavedItem item in items)
            {
                if (entries.Count >= MaxViewpointEntries)
                {
                    truncated = true;
                    return;
                }

                string itemPath = string.IsNullOrEmpty(parentPath)
                    ? item.DisplayName
                    : parentPath + "/" + item.DisplayName;
                var entry = new Dictionary<string, object>
                {
                    { "displayName", LimitText(item.DisplayName) },
                    { "path", LimitText(itemPath) },
                    { "guid", item.Guid.ToString("D") },
                    {
                        "type",
                        item is SavedViewpoint ? "viewpoint" : "folder"
                    }
                };
                entries.Add(entry);

                var group = item as GroupItem;
                if (group != null)
                {
                    AppendSavedItems(
                        group.Children,
                        itemPath,
                        entries,
                        ref truncated);
                    if (truncated)
                    {
                        return;
                    }
                }
            }
        }

        private static bool MatchesFilter(
            string filter,
            string displayName,
            string internalName)
        {
            return filter == null
                || string.Equals(
                    filter,
                    displayName,
                    StringComparison.OrdinalIgnoreCase)
                || string.Equals(
                    filter,
                    internalName,
                    StringComparison.OrdinalIgnoreCase);
        }

        private static bool MatchesText(
            string value,
            string query,
            string matchMode,
            bool caseSensitive)
        {
            if (value == null)
            {
                return false;
            }

            StringComparison comparison = caseSensitive
                ? StringComparison.Ordinal
                : StringComparison.OrdinalIgnoreCase;

            return matchMode == "equals"
                ? string.Equals(value, query, comparison)
                : value.IndexOf(query, comparison) >= 0;
        }

        private static string GetRequiredString(
            IDictionary<string, object> parameters,
            string name,
            int maxLength)
        {
            string value = GetOptionalString(parameters, name, maxLength);
            if (value == null)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " is required.");
            }

            return value;
        }

        private static string GetOptionalString(
            IDictionary<string, object> parameters,
            string name,
            int maxLength)
        {
            object rawValue;
            if (!parameters.TryGetValue(name, out rawValue)
                || rawValue == null)
            {
                return null;
            }

            string value = rawValue as string;
            if (value == null
                || string.IsNullOrWhiteSpace(value)
                || value.Length > maxLength)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be a non-empty string no longer than "
                    + maxLength
                    + " characters.");
            }

            return value.Trim();
        }

        private static bool GetBoolean(
            IDictionary<string, object> parameters,
            string name,
            bool defaultValue)
        {
            object rawValue;
            if (!parameters.TryGetValue(name, out rawValue)
                || rawValue == null)
            {
                return defaultValue;
            }

            if (!(rawValue is bool))
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be a boolean.");
            }

            return (bool)rawValue;
        }

        private static int GetInteger(
            IDictionary<string, object> parameters,
            string name,
            int defaultValue,
            int minimum,
            int maximum)
        {
            object rawValue;
            if (!parameters.TryGetValue(name, out rawValue)
                || rawValue == null)
            {
                return defaultValue;
            }

            int value;
            try
            {
                value = Convert.ToInt32(rawValue);
            }
            catch
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be an integer.");
            }

            if (value < minimum || value > maximum)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be between "
                    + minimum
                    + " and "
                    + maximum
                    + ".");
            }

            return value;
        }

        private static string GetChoice(
            IDictionary<string, object> parameters,
            string name,
            string defaultValue,
            params string[] allowedValues)
        {
            string value = GetOptionalString(parameters, name, 50);
            if (value == null)
            {
                if (defaultValue == null)
                {
                    throw new BridgeException(
                        "INVALID_ARGUMENT",
                        name + " is required.");
                }

                value = defaultValue;
            }

            foreach (string allowedValue in allowedValues)
            {
                if (string.Equals(
                    value,
                    allowedValue,
                    StringComparison.Ordinal))
                {
                    return value;
                }
            }

            throw new BridgeException(
                "INVALID_ARGUMENT",
                name + " has an unsupported value.");
        }

        private static List<string> GetStringList(
            IDictionary<string, object> parameters,
            string name,
            int minimumCount,
            int maximumCount)
        {
            object rawValue;
            if (!parameters.TryGetValue(name, out rawValue)
                || rawValue == null
                || rawValue is string)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be an array of strings.");
            }

            var enumerable = rawValue as IEnumerable;
            if (enumerable == null)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " must be an array of strings.");
            }

            var values = new List<string>();
            foreach (object item in enumerable)
            {
                string value = item as string;
                if (string.IsNullOrWhiteSpace(value) || value.Length > 100)
                {
                    throw new BridgeException(
                        "INVALID_ARGUMENT",
                        name + " contains an invalid item ID.");
                }

                values.Add(value);
                if (values.Count > maximumCount)
                {
                    throw new BridgeException(
                        "INVALID_ARGUMENT",
                        name + " contains too many values.");
                }
            }

            if (values.Count < minimumCount)
            {
                throw new BridgeException(
                    "INVALID_ARGUMENT",
                    name + " contains too few values.");
            }

            return values;
        }

        private static string LimitText(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            if (value.Length <= MaxTextLength)
            {
                return value;
            }

            string clipped = value.Substring(0, MaxTextLength);
            if (char.IsHighSurrogate(clipped[clipped.Length - 1]))
            {
                // Never cut a UTF-16 surrogate pair in half.
                clipped = clipped.Substring(0, clipped.Length - 1);
            }

            return clipped;
        }
    }
}

