#pragma once
#include "core.hpp"

inline QString popplerTool(const char *variable, const QString &name) {
  auto configured = qEnvironmentVariable(variable);
  if (!configured.isEmpty())
    return configured;
  auto textTool = qEnvironmentVariable("PDFTOTEXT");
  if (!textTool.isEmpty()) {
    auto sibling = QFileInfo(textTool).absoluteDir().filePath(
        name + (textTool.endsWith(".exe", Qt::CaseInsensitive) ? ".exe" : ""));
    if (QFile::exists(sibling))
      return sibling;
  }
  return name;
}
bool pdfFigureRoutes(Context &c);
void clearPdfFigureCache(const QString &sourceId);
