(function (global) {
  "use strict";

  global.createSessionTreeModel = function ({ entries, byId, labelMap }) {
    // ============================================================
    // TREE DATA PREPARATION (no DOM, pure data)
    // ============================================================

    /**
     * Build tree structure from flat entries.
     * Returns array of root nodes, each with { entry, children, label }.
     */
    function buildTree() {
      const nodeMap = new Map();
      const roots = [];

      // Create nodes
      for (const entry of entries) {
        nodeMap.set(entry.id, {
          entry,
          children: [],
          label: labelMap.get(entry.id),
        });
      }

      // Build parent-child relationships
      for (const entry of entries) {
        const node = nodeMap.get(entry.id);
        if (
          entry.parentId === null ||
          entry.parentId === undefined ||
          entry.parentId === entry.id
        ) {
          roots.push(node);
        } else {
          const parent = nodeMap.get(entry.parentId);
          if (parent) {
            parent.children.push(node);
          } else {
            roots.push(node);
          }
        }
      }

      // Sort children by timestamp
      function sortChildren(node) {
        node.children.sort(
          (a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
        );
        node.children.forEach(sortChildren);
      }
      roots.forEach(sortChildren);

      return roots;
    }

    /**
     * Build set of entry IDs on path from root to target.
     */
    function buildActivePathIds(targetId) {
      const ids = new Set();
      let current = byId.get(targetId);
      while (current) {
        ids.add(current.id);
        // Stop if no parent or self-referencing (root)
        if (!current.parentId || current.parentId === current.id) {
          break;
        }
        current = byId.get(current.parentId);
      }
      return ids;
    }

    /**
     * Get array of entries from root to target (the conversation path).
     */
    function getPath(targetId) {
      const path = [];
      let current = byId.get(targetId);
      while (current) {
        path.unshift(current);
        // Stop if no parent or self-referencing (root)
        if (!current.parentId || current.parentId === current.id) {
          break;
        }
        current = byId.get(current.parentId);
      }
      return path;
    }

    // Tree node lookup for finding leaves
    let treeNodeMap = null;

    /**
     * Find the newest leaf node reachable from a given node.
     * This allows clicking any node in a branch to show the full branch.
     * Children are sorted by timestamp, so the newest is always last.
     */
    function findNewestLeaf(nodeId) {
      // Build tree node map lazily
      if (!treeNodeMap) {
        treeNodeMap = new Map();
        const tree = buildTree();
        function mapNodes(node) {
          treeNodeMap.set(node.entry.id, node);
          node.children.forEach(mapNodes);
        }
        tree.forEach(mapNodes);
      }

      const node = treeNodeMap.get(nodeId);
      if (!node) {
        return nodeId;
      }

      // Follow the newest (last) child at each level
      let current = node;
      while (current.children.length > 0) {
        current = current.children[current.children.length - 1];
      }
      return current.entry.id;
    }

    /**
     * Flatten tree into list with indentation and connector info.
     * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
     * Matches tree-selector.ts logic exactly.
     */
    function flattenTree(roots, activePathIds) {
      const result = [];
      const multipleRoots = roots.length > 1;

      // Mark which subtrees contain the active leaf
      const containsActive = new Map();
      function markActive(node) {
        let has = activePathIds.has(node.entry.id);
        for (const child of node.children) {
          if (markActive(child)) {
            has = true;
          }
        }
        containsActive.set(node, has);
        return has;
      }
      roots.forEach(markActive);

      // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
      const stack = [];

      // Add roots (prioritize branch containing active leaf)
      const orderedRoots = [...roots].toSorted(
        (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
      );
      for (let i = orderedRoots.length - 1; i >= 0; i--) {
        const isLast = i === orderedRoots.length - 1;
        stack.push([
          orderedRoots[i],
          multipleRoots ? 1 : 0,
          multipleRoots,
          multipleRoots,
          isLast,
          [],
          multipleRoots,
        ]);
      }

      while (stack.length > 0) {
        const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
          stack.pop();

        result.push({
          node,
          indent,
          showConnector,
          isLast,
          gutters,
          isVirtualRootChild,
          multipleRoots,
        });

        const children = node.children;
        const multipleChildren = children.length > 1;

        // Order children (active branch first)
        const orderedChildren = [...children].toSorted(
          (a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)),
        );

        // Calculate child indent (matches tree-selector.ts)
        let childIndent;
        if (multipleChildren) {
          // Parent branches: children get +1
          childIndent = indent + 1;
        } else if (justBranched && indent > 0) {
          // First generation after a branch: +1 for visual grouping
          childIndent = indent + 1;
        } else {
          // Single-child chain: stay flat
          childIndent = indent;
        }

        // Build gutters for children
        const connectorDisplayed = showConnector && !isVirtualRootChild;
        const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connectorPosition = Math.max(0, currentDisplayIndent - 1);
        const childGutters = connectorDisplayed
          ? [...gutters, { position: connectorPosition, show: !isLast }]
          : gutters;

        // Add children in reverse order for stack
        for (let i = orderedChildren.length - 1; i >= 0; i--) {
          const childIsLast = i === orderedChildren.length - 1;
          stack.push([
            orderedChildren[i],
            childIndent,
            multipleChildren,
            multipleChildren,
            childIsLast,
            childGutters,
            false,
          ]);
        }
      }

      return result;
    }

    /**
     * Build ASCII prefix string for tree node.
     */
    function buildTreePrefix(flatNode) {
      const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } =
        flatNode;
      const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
      const connector = showConnector && !isVirtualRootChild ? (isLast ? "└─ " : "├─ ") : "";
      const connectorPosition = connector ? displayIndent - 1 : -1;

      const totalChars = displayIndent * 3;
      const prefixChars = [];
      for (let i = 0; i < totalChars; i++) {
        const level = Math.floor(i / 3);
        const posInLevel = i % 3;

        const gutter = gutters.find((g) => g.position === level);
        if (gutter) {
          prefixChars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
        } else if (connector && level === connectorPosition) {
          if (posInLevel === 0) {
            prefixChars.push(isLast ? "└" : "├");
          } else if (posInLevel === 1) {
            prefixChars.push("─");
          } else {
            prefixChars.push(" ");
          }
        } else {
          prefixChars.push(" ");
        }
      }
      return prefixChars.join("");
    }

    // ============================================================
    // FILTERING (pure data)
    // ============================================================

    let filterMode = "default";
    let searchQuery = "";

    function hasTextContent(content) {
      if (typeof content === "string") {
        return content.trim().length > 0;
      }
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text" && c.text && c.text.trim().length > 0) {
            return true;
          }
        }
      }
      return false;
    }

    function extractContent(content) {
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");
      }
      return "";
    }

    function getSearchableText(entry, label) {
      const parts = [];
      if (label) {
        parts.push(label);
      }

      switch (entry.type) {
        case "message": {
          const msg = entry.message;
          parts.push(msg.role);
          if (msg.content) {
            parts.push(extractContent(msg.content));
          }
          if (msg.role === "bashExecution" && msg.command) {
            parts.push(msg.command);
          }
          break;
        }
        case "custom_message":
          parts.push(entry.customType);
          parts.push(
            typeof entry.content === "string" ? entry.content : extractContent(entry.content),
          );
          break;
        case "compaction":
          parts.push("compaction");
          break;
        case "branch_summary":
          parts.push("branch summary", entry.summary);
          break;
        case "model_change":
          parts.push("model", entry.modelId);
          break;
        case "thinking_level_change":
          parts.push("thinking", entry.thinkingLevel);
          break;
      }

      return parts.join(" ").toLowerCase();
    }

    /**
     * Filter flat nodes based on current filterMode and searchQuery.
     */
    function filterNodes(flatNodes, currentLeafId) {
      const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

      const filtered = flatNodes.filter((flatNode) => {
        const entry = flatNode.node.entry;
        const label = flatNode.node.label;
        const isCurrentLeaf = entry.id === currentLeafId;

        // Always show current leaf
        if (isCurrentLeaf) {
          return true;
        }

        // Hide assistant messages with only tool calls (no text) unless error/aborted
        if (entry.type === "message" && entry.message.role === "assistant") {
          const msg = entry.message;
          const hasText = hasTextContent(msg.content);
          const isErrorOrAborted =
            msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
          if (!hasText && !isErrorOrAborted) {
            return false;
          }
        }

        // Apply filter mode
        const isSettingsEntry = [
          "label",
          "custom",
          "model_change",
          "thinking_level_change",
        ].includes(entry.type);
        let passesFilter = true;

        switch (filterMode) {
          case "user-only":
            passesFilter = entry.type === "message" && entry.message.role === "user";
            break;
          case "no-tools":
            passesFilter =
              !isSettingsEntry &&
              !(entry.type === "message" && entry.message.role === "toolResult");
            break;
          case "labeled-only":
            passesFilter = label !== undefined;
            break;
          case "all":
            passesFilter = true;
            break;
          default: // 'default'
            passesFilter = !isSettingsEntry;
            break;
        }

        if (!passesFilter) {
          return false;
        }

        // Apply search filter
        if (searchTokens.length > 0) {
          const nodeText = getSearchableText(entry, label);
          if (!searchTokens.every((t) => nodeText.includes(t))) {
            return false;
          }
        }

        return true;
      });

      // Recalculate visual structure based on visible tree
      recalculateVisualStructure(filtered, flatNodes);

      return filtered;
    }

    /**
     * Recompute indentation/connectors for the filtered view
     *
     * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
     * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
     */
    function recalculateVisualStructure(filteredNodes, allFlatNodes) {
      if (filteredNodes.length === 0) {
        return;
      }

      const visibleIds = new Set(filteredNodes.map((n) => n.node.entry.id));

      // Build entry map for parent lookup (using full tree)
      const entryMap = new Map();
      for (const flatNode of allFlatNodes) {
        entryMap.set(flatNode.node.entry.id, flatNode);
      }

      // Find nearest visible ancestor for a node
      function findVisibleAncestor(nodeId) {
        let currentId = entryMap.get(nodeId)?.node.entry.parentId;
        while (currentId != null) {
          if (visibleIds.has(currentId)) {
            return currentId;
          }
          currentId = entryMap.get(currentId)?.node.entry.parentId;
        }
        return null;
      }

      // Build visible tree structure
      const visibleParent = new Map();
      const visibleChildren = new Map();
      visibleChildren.set(null, []); // root-level nodes

      for (const flatNode of filteredNodes) {
        const nodeId = flatNode.node.entry.id;
        const ancestorId = findVisibleAncestor(nodeId);
        visibleParent.set(nodeId, ancestorId);

        if (!visibleChildren.has(ancestorId)) {
          visibleChildren.set(ancestorId, []);
        }
        visibleChildren.get(ancestorId).push(nodeId);
      }

      // Update multipleRoots based on visible roots
      const visibleRootIds = visibleChildren.get(null);
      const multipleRoots = visibleRootIds.length > 1;

      // Build a map for quick lookup: nodeId → FlatNode
      const filteredNodeMap = new Map();
      for (const flatNode of filteredNodes) {
        filteredNodeMap.set(flatNode.node.entry.id, flatNode);
      }

      // DFS traversal of visible tree, applying same indentation rules as flattenTree()
      // Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
      const stack = [];

      // Add visible roots in reverse order (to process in forward order via stack)
      for (let i = visibleRootIds.length - 1; i >= 0; i--) {
        const isLast = i === visibleRootIds.length - 1;
        stack.push([
          visibleRootIds[i],
          multipleRoots ? 1 : 0,
          multipleRoots,
          multipleRoots,
          isLast,
          [],
          multipleRoots,
        ]);
      }

      while (stack.length > 0) {
        const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] =
          stack.pop();

        const flatNode = filteredNodeMap.get(nodeId);
        if (!flatNode) {
          continue;
        }

        // Update this node's visual properties
        flatNode.indent = indent;
        flatNode.showConnector = showConnector;
        flatNode.isLast = isLast;
        flatNode.gutters = gutters;
        flatNode.isVirtualRootChild = isVirtualRootChild;
        flatNode.multipleRoots = multipleRoots;

        // Get visible children of this node
        const children = visibleChildren.get(nodeId) || [];
        const multipleChildren = children.length > 1;

        // Calculate child indent using same rules as flattenTree():
        // - Parent branches (multiple children): children get +1
        // - Just branched and indent > 0: children get +1 for visual grouping
        // - Single-child chain: stay flat
        let childIndent;
        if (multipleChildren) {
          childIndent = indent + 1;
        } else if (justBranched && indent > 0) {
          childIndent = indent + 1;
        } else {
          childIndent = indent;
        }

        // Build gutters for children (same logic as flattenTree)
        const connectorDisplayed = showConnector && !isVirtualRootChild;
        const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connectorPosition = Math.max(0, currentDisplayIndent - 1);
        const childGutters = connectorDisplayed
          ? [...gutters, { position: connectorPosition, show: !isLast }]
          : gutters;

        // Add children in reverse order (to process in forward order via stack)
        for (let i = children.length - 1; i >= 0; i--) {
          const childIsLast = i === children.length - 1;
          stack.push([
            children[i],
            childIndent,
            multipleChildren,
            multipleChildren,
            childIsLast,
            childGutters,
            false,
          ]);
        }
      }
    }

    return {
      buildTree,
      buildActivePathIds,
      getPath,
      findNewestLeaf,
      flattenTree,
      buildTreePrefix,
      extractContent,
      filterNodes,
      setFilterMode(value) {
        filterMode = value;
      },
      setSearchQuery(value) {
        searchQuery = value;
      },
    };
  };
})(window);
