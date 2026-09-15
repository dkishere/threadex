const record = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** Store each position once, while preserving component identity and call-site roles. */
export function reactContextMetadata(inspection) {
    const locations = [];
    const indexes = new Map();
    const reference = (value) => {
        if (!record(value) || typeof value.fileName !== "string")
            return null;
        const key = JSON.stringify([value.fileName, value.lineNumber, value.columnNumber, value.coordinates, value.method, value.fiberVersion]);
        const existing = indexes.get(key);
        if (existing !== undefined)
            return existing;
        const id = locations.length;
        indexes.set(key, id);
        locations.push({ ...value });
        return id;
    };
    const references = (value) => Array.isArray(value)
        ? [...new Set(value.map(reference).filter((id) => id !== null))] : [];
    const elementSource = reference(inspection.elementSource);
    const elementStack = references(inspection.elementSourceStack);
    const ancestor = record(inspection.ancestorSource) ? {
        name: inspection.ancestorSource.name,
        distance: inspection.ancestorSource.distance,
        sourceRef: reference(inspection.ancestorSource.source),
        stackRefs: references(inspection.ancestorSource.sourceStack),
    } : null;
    const components = Array.isArray(inspection.components) ? inspection.components.filter(record).map(component => ({
        name: component.name,
        fiberTag: component.fiberTag,
        sourceRole: component.sourceRole,
        sourceRef: reference(component.source),
        creationSourceRef: reference(component.creationSource),
        stackRefs: references(component.sourceStack),
    })) : [];
    return {
        "react-trace-version": 2,
        "react-source-locations": locations,
        "react-components": components,
        "react-element": {
            sourceRef: elementSource,
            stackRefs: elementStack,
            sourceStatus: inspection.elementSourceStatus ?? "debug-metadata-unavailable",
            nearestAncestor: ancestor,
        },
        "react-trace-truncated": inspection.truncated === true,
    };
}
