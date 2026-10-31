export function binaryNameCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function flattenBinarySorted(tree, prefix = "") {
  const output = [];
  for (const [name, value] of Object.entries(tree)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (value && typeof value === "object") output.push(...flattenBinarySorted(value, relative));
    else output.push(relative);
  }
  return output.sort(binaryNameCompare);
}
