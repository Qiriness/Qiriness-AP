// Groups embedded messages by what they are actually about, so a pile of support
// mail becomes a ranked list of recurring topics.
//
// WHY THIS EXISTS. The support taxonomy tells you which *subject* needs
// coverage — `order` is 36 tickets against 0 knowledge chunks — but "write an
// article about orders" is not a task. Inside `order` sit checkout failures,
// dispatch delays, free-gift problems and address corrections: different
// questions with different answers. No label separates them (there is no
// `order.checkout_failure` category, and inventing one would mean re-labelling
// everything), so the only thing that knows two emails are the same problem is
// the text — and the vector is its machine-readable form. Keyword counting will
// not do it either: French support mail says colis / paquet / commande for the
// same thing, and "je n'ai rien reçu" shares no words with "toujours pas livré".
//
// Pure: takes rows carrying a vector, returns groups. No I/O, so the clustering
// rules are unit-testable and the script stays a thin shell.

/**
 * AVERAGE-link, deliberately, not single-link.
 *
 * Single-link joins a candidate to a cluster if it resembles ANY one member,
 * which chains: A resembles B, B resembles C, so A and C end up together even
 * when unrelated. Measured on this corpus that put 52 of 55 `order` messages in
 * one blob. Average-link requires a candidate to resemble the group as a whole,
 * which holds the boundaries.
 */
export function clusterByAverageLink(items, { threshold = 0.68, minSize = 2 } = {}) {
  const vectors = items.map((item) => normalise(item.vector));
  const similarity = pairwiseSimilarity(vectors);

  let groups = items.map((_, index) => [index]);
  for (;;) {
    let mergeA = -1;
    let mergeB = -1;
    let best = threshold;

    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const mean = averageBetween(groups[a], groups[b], similarity);
        if (mean > best) {
          best = mean;
          mergeA = a;
          mergeB = b;
        }
      }
    }

    // Nothing left that resembles anything else closely enough.
    if (mergeA < 0) {
      break;
    }
    groups[mergeA] = groups[mergeA].concat(groups[mergeB]);
    groups.splice(mergeB, 1);
  }

  return groups
    .map((members) => buildGroup(members, items, similarity))
    .filter((group) => group.size >= minSize)
    .sort((a, b) => b.size - a.size || b.weight - a.weight);
}

/**
 * Collapses near-identical messages before clustering.
 *
 * A customer resending the same email, or a thread quoting itself, produces
 * vectors ~1.0 apart. Left in, they form a perfect cluster that looks like
 * demand — on this corpus one "group of 5" turned out to be a single message
 * repeated five times. Each survivor carries how many it stands for, so the
 * counts stay honest without the duplicates inflating them.
 */
export function dedupeNearIdentical(items, { threshold = 0.97 } = {}) {
  const vectors = items.map((item) => normalise(item.vector));
  const kept = [];
  const absorbedBy = new Array(items.length).fill(-1);

  for (let i = 0; i < items.length; i += 1) {
    if (absorbedBy[i] >= 0) {
      continue;
    }
    const duplicates = [];
    for (let j = i + 1; j < items.length; j += 1) {
      if (absorbedBy[j] < 0 && dot(vectors[i], vectors[j]) >= threshold) {
        absorbedBy[j] = i;
        duplicates.push(items[j].id);
      }
    }
    kept.push({ ...items[i], duplicates: duplicates.length, duplicateIds: duplicates });
  }

  return kept;
}

/**
 * The member most similar to all the others — the group's most representative
 * message. Preferred over a centroid because it is real text a person can read
 * and promote to an exemplar, rather than an average that exists nowhere.
 */
function buildGroup(members, items, similarity) {
  let medoid = members[0];
  let bestScore = -Infinity;
  let total = 0;
  let pairs = 0;

  for (const i of members) {
    let score = 0;
    for (const j of members) {
      if (i === j) continue;
      score += similarity[i][j];
      total += similarity[i][j];
      pairs += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      medoid = i;
    }
  }

  // Each item may stand for duplicates absorbed before clustering.
  const size = members.reduce((n, i) => n + 1 + (items[i].duplicates || 0), 0);

  return {
    members: members.map((i) => items[i]),
    medoid: items[medoid],
    size,
    distinct: members.length,
    // Mean intra-group similarity: how tight the topic is. A loose group is a
    // hint the threshold wants raising for this corpus.
    weight: pairs > 0 ? total / pairs : 1
  };
}

function averageBetween(groupA, groupB, similarity) {
  let total = 0;
  for (const a of groupA) {
    for (const b of groupB) {
      total += similarity[a][b];
    }
  }
  return total / (groupA.length * groupB.length);
}

function pairwiseSimilarity(vectors) {
  const n = vectors.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const value = dot(vectors[i], vectors[j]);
      matrix[i][j] = value;
      matrix[j][i] = value;
    }
  }
  return matrix;
}

/**
 * Unit-normalises so a dot product IS the cosine similarity. OpenAI returns
 * normalised vectors already, but normalising here keeps the maths correct for
 * any source and costs nothing at this scale.
 */
export function normalise(vector) {
  const values = Array.isArray(vector) ? vector : parseVector(vector);
  let norm = 0;
  for (const value of values) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  return norm > 0 ? values.map((value) => value / norm) : values;
}

/** pgvector reads back as the text literal `[a,b,c]`. */
export function parseVector(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  return JSON.parse(value);
}

export function dot(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += a[i] * b[i];
  }
  return total;
}

/** Cosine similarity between two vectors in any form. */
export function cosine(a, b) {
  return dot(normalise(a), normalise(b));
}
