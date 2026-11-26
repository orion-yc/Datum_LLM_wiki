#pragma once
#include "core.hpp"

struct StudyEvidence {
  Arr chunks;
  int total;
};

// Keep only IDs in memory when selecting evidence for long books.
inline StudyEvidence studyEvidence(Database &db, const QString &source, const QString &focus, int limit) {
  const QString where = " FROM chunks WHERE source_id=? AND active=1";
  const auto ordered = db.all("SELECT id" + where + " ORDER BY page,position,id", {source});
  const int total = int(ordered.size());
  require(total > 0, 409, "这份资料没有可用正文。");
  limit = qMin(limit, total);
  QSet<QString> chosen;
  auto terms = tokens(focus);
  terms.removeDuplicates();
  if (total > limit && !terms.isEmpty()) {
    QStringList weights;
    QVariantList args;
    for (const auto &term : terms.mid(0, 12)) {
      weights << "(3*(instr(lower(heading),?)>0)+(instr(lower(content),?)>0))";
      args << term << term;
    }
    args << source << limit / 2;
    const auto matches = db.all("SELECT id," + weights.join('+') + " AS relevance" + where +
                                " ORDER BY relevance DESC,page,position,id LIMIT ?", args);
    for (auto v : matches)
      if (v.toObject()["relevance"].toInt() > 0)
        chosen.insert(str(v.toObject(), "id"));
  }
  const int remaining = limit - int(chosen.size());
  for (int i = 0; i < remaining; ++i)
    chosen.insert(str(ordered[i * qint64(total - 1) / qMax(1, remaining - 1)].toObject(), "id"));
  // Ranked and distributed positions can overlap.
  for (auto v : ordered) {
    if (chosen.size() >= limit) break;
    chosen.insert(str(v.toObject(), "id"));
  }
  QVariantList args;
  QStringList placeholders;
  for (const auto &id : chosen) {
    args << id;
    placeholders << "?";
  }
  return {db.all("SELECT id,source_id,page,heading,substr(content,1,1800) content FROM chunks WHERE id IN (" +
                 placeholders.join(',') + ") ORDER BY page,position,id", args), total};
}
