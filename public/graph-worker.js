/* Web Worker for the CPU-heavy, deterministic graph layout phase. */

function graphHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function graphEdgeStrength(edge) {
  const typeWeight = edge.type === "link" ? 9 : edge.type === "missing" ? 7 : edge.type === "tag" ? 4 : 2;
  return typeWeight * (1 + Math.log2(1 + Math.max(1, edge.weight || 1)) * 0.24);
}

function buildNeuralBackbone(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const centrality = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge, index) => {
    edge.layoutIndex = index;
    edge.backbone = false;
    const strength = graphEdgeStrength(edge);
    adjacency.get(edge.source)?.push({ id: edge.target, edge, strength });
    adjacency.get(edge.target)?.push({ id: edge.source, edge, strength });
    centrality.set(edge.source, (centrality.get(edge.source) || 0) + strength);
    centrality.set(edge.target, (centrality.get(edge.target) || 0) + strength);
  });
  for (let pass = 0; pass < 4; pass += 1) {
    const next = new Map();
    let max = 1;
    for (const node of nodes) {
      const neighbors = adjacency.get(node.id) || [];
      const propagated = neighbors.reduce((sum, item) => sum + (centrality.get(item.id) || 0) * item.strength * 0.025, 0);
      const score = (centrality.get(node.id) || 0) * 0.72 + propagated;
      next.set(node.id, score);
      max = Math.max(max, score);
    }
    for (const node of nodes) centrality.set(node.id, next.get(node.id) / max);
  }
  nodes.forEach((node) => { node.centrality = centrality.get(node.id) || 0; });
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return false;
    parent.set(rootB, rootA);
    return true;
  };
  [...edges]
    .sort((a, b) => graphEdgeStrength(b) - graphEdgeStrength(a)
      || (centrality.get(b.source) || 0) + (centrality.get(b.target) || 0)
      - (centrality.get(a.source) || 0) - (centrality.get(a.target) || 0))
    .forEach((edge) => {
      if (union(edge.source, edge.target)) edge.backbone = true;
    });
  const tree = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges.filter((item) => item.backbone)) {
    tree.get(edge.source)?.push(edge.target);
    tree.get(edge.target)?.push(edge.source);
  }
  const componentNodes = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    if (!componentNodes.has(root)) componentNodes.set(root, []);
    componentNodes.get(root).push(node);
  }
  const components = [...componentNodes.values()].sort((a, b) => b.length - a.length);
  const isolated = components.filter((component) => component.length === 1);
  const connected = components.filter((component) => component.length > 1);
  connected.forEach((component) => {
    const componentIds = new Set(component.map((node) => node.id));
    const root = [...component].sort((a, b) => {
      const docBiasA = a.kind === "doc" ? 0.18 : 0;
      const docBiasB = b.kind === "doc" ? 0.18 : 0;
      return b.centrality + docBiasB - a.centrality - docBiasA;
    })[0];
    root.layoutRoot = true;
    const children = new Map(component.map((node) => [node.id, []]));
    const depth = new Map([[root.id, 0]]);
    const queue = [root.id];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const id = queue[cursor];
      for (const neighbor of tree.get(id) || []) {
        if (!componentIds.has(neighbor) || depth.has(neighbor)) continue;
        depth.set(neighbor, depth.get(id) + 1);
        children.get(id).push(neighbor);
        queue.push(neighbor);
      }
    }
    const subtree = new Map();
    const measure = (id) => {
      const childIds = children.get(id) || [];
      const size = childIds.length ? childIds.reduce((sum, child) => sum + measure(child), 0) : 1;
      subtree.set(id, size);
      return size;
    };
    measure(root.id);
    const maxLayer = new Map();
    depth.forEach((value) => maxLayer.set(value, (maxLayer.get(value) || 0) + 1));
    const ringRadius = new Map([...maxLayer].map(([level, count]) => [level, Math.max(level * 106, count * 23 / (Math.PI * 2))]));
    root.x = 0;
    root.y = 0;
    const place = (id, startAngle, endAngle) => {
      let angle = startAngle;
      const total = Math.max(1, subtree.get(id) || 1);
      for (const childId of children.get(id) || []) {
        const portion = (endAngle - startAngle) * (subtree.get(childId) || 1) / total;
        const childAngle = angle + portion / 2;
        const level = depth.get(childId) || 1;
        const radius = ringRadius.get(level) || level * 106;
        const child = byId.get(childId);
        child.x = Math.cos(childAngle) * radius;
        child.y = Math.sin(childAngle) * radius;
        place(childId, angle, angle + portion);
        angle += portion;
      }
    };
    place(root.id, -Math.PI, Math.PI);
    component.layoutRadius = Math.max(120, ...component.map((node) => Math.hypot(node.x || 0, node.y || 0) + 38));
  });
  const mainRadius = connected[0]?.layoutRadius || 100;
  connected.forEach((component, index) => {
    if (index === 0) return;
    const angle = index * 2.399963;
    const distance = mainRadius + component.layoutRadius + 90 + Math.sqrt(index) * 55;
    const offsetX = Math.cos(angle) * distance;
    const offsetY = Math.sin(angle) * distance;
    component.forEach((node) => { node.x += offsetX; node.y += offsetY; });
  });
  const outerRadius = mainRadius + 150 + Math.sqrt(isolated.length) * 24;
  isolated.forEach((component, index) => {
    const node = component[0];
    const angle = -Math.PI / 2 + index * 2.399963;
    const radius = outerRadius + (index % 3) * 34;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  });
}

function layoutGraph(graph) {
  const nodes = graph.nodes.map((node) => ({ ...node, label: node.label || node.id.split("/").pop(), vx: 0, vy: 0 }));
  const edges = graph.edges.map((edge) => ({ ...edge }));
  buildNeuralBackbone(nodes, edges);
  nodes.forEach((node) => { node.targetX = node.x; node.targetY = node.y; });
  const byId = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const springs = edges.map((edge) => ({ edge, a: byId.get(edge.source)?.index, b: byId.get(edge.target)?.index }))
    .filter((item) => item.a !== undefined && item.b !== undefined);
  const iterations = nodes.length < 120 ? 72 : nodes.length < 420 ? 44 : 24;
  const fx = new Float64Array(nodes.length);
  const fy = new Float64Array(nodes.length);
  const cellSize = 96;
  for (let step = 0; step < iterations; step += 1) {
    fx.fill(0);
    fy.fill(0);
    const grid = new Map();
    nodes.forEach((node, index) => {
      const key = `${Math.floor(node.x / cellSize)},${Math.floor(node.y / cellSize)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(index);
    });
    nodes.forEach((node, index) => {
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      for (let ox = -1; ox <= 1; ox += 1) for (let oy = -1; oy <= 1; oy += 1) {
        for (const otherIndex of grid.get(`${cx + ox},${cy + oy}`) || []) {
          if (otherIndex <= index) continue;
          const other = nodes[otherIndex];
          let dx = other.x - node.x;
          let dy = other.y - node.y;
          let distanceSq = dx * dx + dy * dy;
          if (distanceSq < 1) {
            dx = 0.5 - graphHash(`${node.id}:${other.id}`);
            dy = 0.5 - graphHash(`${other.id}:${node.id}`);
            distanceSq = dx * dx + dy * dy;
          }
          if (distanceSq > 26000) continue;
          const distance = Math.sqrt(distanceSq);
          const force = 1120 / (distanceSq + 90);
          const pushX = (dx / distance) * force;
          const pushY = (dy / distance) * force;
          fx[index] -= pushX; fy[index] -= pushY;
          fx[otherIndex] += pushX; fy[otherIndex] += pushY;
        }
      }
    });
    for (const spring of springs) {
      const a = nodes[spring.a];
      const b = nodes[spring.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = spring.edge.type === "tag" ? 72 : spring.edge.type === "keyword" ? 88 : 104;
      const strength = spring.edge.backbone ? (spring.edge.type === "link" ? 0.02 : 0.014) : 0.0014;
      const pull = (distance - desired) * strength * Math.min(2, 0.7 + spring.edge.weight * 0.18);
      const pullX = (dx / distance) * pull;
      const pullY = (dy / distance) * pull;
      fx[spring.a] += pullX; fy[spring.a] += pullY;
      fx[spring.b] -= pullX; fy[spring.b] -= pullY;
    }
    nodes.forEach((node, index) => {
      const attraction = node.layoutRoot ? 0.12 : 0.028;
      fx[index] += (node.targetX - node.x) * attraction;
      fy[index] += (node.targetY - node.y) * attraction;
      node.vx = (node.vx + fx[index]) * 0.72;
      node.vy = (node.vy + fy[index]) * 0.72;
      const speed = Math.max(1, Math.hypot(node.vx, node.vy));
      const limit = Math.min(9, speed);
      node.x += (node.vx / speed) * limit;
      node.y += (node.vy / speed) * limit;
    });
  }
  return { nodes, edges, stats: graph.stats || {} };
}

self.onmessage = (event) => {
  const { id, graph } = event.data || {};
  if (!id || !graph) return;
  try {
    self.postMessage({ id, layout: layoutGraph(graph) });
  } catch (error) {
    self.postMessage({ id, error: error?.message || "Graph layout failed" });
  }
};
