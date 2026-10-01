import Foundation

enum WebContentReadiness {
    static func inspect(_ rows: [[String: Any]], depthLimited: Bool, nodeLimited: Bool) -> [String: Any] {
        let byID = Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            (row["id"] as? String).map { ($0, row) }
        })
        func ancestors(_ row: [String: Any]) -> Set<String> {
            var result = Set<String>(), current = row["parent"] as? String
            while let id = current, result.insert(id).inserted { current = byID[id]?["parent"] as? String }
            return result
        }
        let embedded = rows.filter { row in
            guard row["role"] as? String != "AXWebArea" else { return false }
            let name = ((row["title"] as? String ?? "") + " " + (row["description"] as? String ?? "")).lowercased()
            return name.contains("webview") || name.contains("browseruserview") || name.contains("cefbrowserhostview")
        }
        let embeddedParents = embedded.reduce(into: Set<String>()) { $0.formUnion(ancestors($1)) }
        let webAreas = rows.filter { $0["role"] as? String == "AXWebArea" }
        let webParents = webAreas.reduce(into: Set<String>()) { $0.formUnion(ancestors($1)) }
        let missing = embedded.compactMap { row -> [String: String]? in
            guard let id = row["id"] as? String, !embeddedParents.contains(id), !webParents.contains(id) else { return nil }
            return ["id": id, "label": row["description"] as? String ?? row["title"] as? String ?? "embedded browser"]
        }
        let status = missing.isEmpty ? (embedded.isEmpty && webAreas.isEmpty ? "not_detected" : "ready") :
            depthLimited ? "depth_limited" : nodeLimited ? "node_limited" : "pending"
        return ["status": status, "missing": missing]
    }
}
