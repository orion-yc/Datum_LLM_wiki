#include "pdf_figures.hpp"
#include <QImageReader>
#include <chrono>
#include <memory>
#include <mutex>
#ifdef Q_OS_LINUX
#include <sys/resource.h>
#endif

namespace {
// Poppler reads the immutable uploaded PDF on demand. Keep only bounded, reproducible results.
std::timed_mutex renderLock;
QCache<QString,QByteArray> originals(24 * 1024); // KiB
struct Layout {
  QSize size;
  QList<QRect> rectangles;
  bool wholePage = false;
};
QCache<QString,Layout> layouts(1024);

QByteArray execute(const QString &program, const QStringList &args, const QString &dir) {
  QProcess p;
  auto env = QProcessEnvironment::systemEnvironment();
  env.insert("LC_ALL","C");
  p.setProcessEnvironment(env);
  p.setStandardOutputFile(dir + "/out");
  p.setStandardErrorFile(QProcess::nullDevice());
#ifdef Q_OS_LINUX
  p.setChildProcessModifier([] {
    const struct rlimit memory{384 * 1024 * 1024, 384 * 1024 * 1024}, file{16 * 1024 * 1024, 16 * 1024 * 1024};
    setrlimit(RLIMIT_AS, &memory);
    setrlimit(RLIMIT_FSIZE, &file);
  });
#endif
  p.start(program, args);
  require(p.waitForStarted(3000), 503, "无法启动 PDF 图像工具。");
  if (!p.waitForFinished(15000)) {
    p.kill();
    p.waitForFinished(3000);
    throw Error(503,"原页读取超时，请稍后重试。");
  }
  require(p.exitStatus() == QProcess::NormalExit && p.exitCode() == 0, 422, "无法读取 PDF 原图。");
  require(QFileInfo(dir + "/out").size() <= 1024 * 1024, 422, "PDF 页面信息过长。");
  return readFile(dir + "/out");
}

Layout detect(const QString &pdf, const QString &page, const QString &dir) {
  QStringList range{"-f",page,"-l",page};
  Layout layout;
  // When the graphics layer cannot be separated, preserve all pixels in the original.
  layout.wholePage = true;
  const auto info = execute(popplerTool("PDFINFO","pdfinfo"), range + QStringList{pdf}, dir);
  auto dims = QRegularExpression(R"(size:\s*([\d.]+) x ([\d.]+) pts)").match(QString::fromLatin1(info));
  double width = dims.captured(1).toDouble(), height = dims.captured(2).toDouble();
  if (!(width > 0 && height > 0) || qMax(width,height) > 2200) return layout;
  auto images = execute(popplerTool("PDFIMAGES","pdfimages"), range + QStringList{"-list",pdf}, dir);
  bool hasEmbeddedImage = false;
  for (const auto &line : images.split('\n')) {
    auto fields = line.simplified().split(' ');
    if (fields.size() < 14 || fields[2] != "image") continue;
    hasEmbeddedImage = true;
    double w = fields[3].toDouble() * 72 / qMax(1.,fields[12].toDouble());
    double h = fields[4].toDouble() * 72 / qMax(1.,fields[13].toDouble());
    if ((w >= .86*width && h >= .86*height) || (w >= .86*height && h >= .86*width)) return layout;
  }
  const auto zoom = QString::number(qBound(.5, 1000 / qMax(width,height), 1.5),'f',4);
  execute(popplerTool("PDFTOHTML","pdftohtml"), range + QStringList{"-q","-c","-noframes","-zoom",zoom,
          "-fmt","png",pdf,dir + "/layer.html"}, dir);
  auto files = QDir(dir).entryList({"layer*.png"},QDir::Files);
  if (files.size() != 1) return layout;
  QImageReader reader(dir + "/" + files.first());
  auto size = reader.size();
  if (!size.isValid() || qMax(size.width(),size.height()) > 3000) return layout;
  QImage img = reader.read().convertToFormat(QImage::Format_ARGB32);
  if (img.isNull()) return layout;
  layout.size = img.size();
  QRect band;
  const int gap = qMax(10, img.height()/38);
  auto finishBand = [&] {
    if (band.width() >= 6 && band.height() >= 3)
      layout.rectangles.append(band.adjusted(-10,-10,10,12).intersected(img.rect()));
    band = QRect();
  };
  for (int y = 0; y < img.height(); ++y) {
    const auto *pixels = reinterpret_cast<const QRgb *>(img.constScanLine(y));
    int left = img.width(), right = -1;
    for (int x = 0; x < img.width(); ++x) {
      const auto pixel = pixels[x];
      if (qAlpha(pixel) >= 32 && qMin(qRed(pixel),qMin(qBlue(pixel),qGreen(pixel))) < 246) {
        left = qMin(left,x);
        right = x;
      }
    }
    if (right < left) continue;
    if (!band.isNull() && y - band.bottom() > gap) finishBand();
    band |= QRect(left,y,right-left+1,1);
  }
  finishBand();
  layout.wholePage = (hasEmbeddedImage && layout.rectangles.isEmpty()) || layout.rectangles.size() > 12 ||
                     (layout.rectangles.size() == 1 && layout.rectangles[0].height() > img.height() * .88 &&
                      layout.rectangles[0].width() > img.width() * .85);
  return layout;
}

QByteArray original(const QString &key, const QString &pdf, const QString &page, const QString &dir) {
  if (auto cached = originals.object(key)) return *cached;
  const QString prefix = dir + "/original";
  execute(popplerTool("PDFTOPPM","pdftoppm"), {"-f",page,"-l",page,"-singlefile","-scale-to","1800",
          "-jpeg",pdf,prefix}, dir);
  const auto bytes = QFileInfo(prefix + ".jpg").size();
  require(bytes > 0 && bytes <= 8*1024*1024,422,"原页图像大小异常。");
  auto data = readFile(prefix + ".jpg");
  originals.insert(key,new QByteArray(data),int(bytes/1024+1));
  return data;
}
}

void clearPdfFigureCache(const QString &id) {
  std::lock_guard lock(renderLock);
  for (const auto &key : originals.keys()) if (key.startsWith(id + '/')) originals.remove(key);
  for (const auto &key : layouts.keys()) if (key.startsWith(id + '/')) layouts.remove(key);
}

bool pdfFigureRoutes(Context &c) {
  const auto &p = c.path;
  if (p.size()<4 || p[1]!="sources" || p[3]!="pdf-figures") return false;
  require(c.method("GET") && (p.size()==5 || p.size()==6),404,"原图地址无效。");
  const auto src = c.db.must("sources",p[2]);
  require(str(src,"type")=="pdf",400,"仅 PDF 资料支持原图。");
  bool ok;
  int page = p[4].toInt(&ok);
  require(ok && page>0 && page<=src["pages"].toInt() && p[4]==QString::number(page),404,"PDF 页码不存在。");
  std::unique_lock lock(renderLock,std::defer_lock);
  require(lock.try_lock_for(std::chrono::seconds(10)),503,"原图正在生成，请稍后重试。");
  QString key = p[2] + "/" + p[4], pdf = dataDir + "/uploads/" + p[2];
  require(QFile::exists(pdf),404,"找不到原始 PDF 文件。");
  QTemporaryDir temp;
  require(temp.isValid(),500,"无法创建原图工作目录。");
  bool full = p.size()==6 && p[5]=="original";
  Layout *layout = nullptr;
  int index = 0;
  if (!full) {
    layout = layouts.object(key);
    if (!layout) {
      auto result = std::make_unique<Layout>();
      try {
        *result = detect(pdf,p[4],temp.path());
      } catch (const Error &) {
        result->wholePage = true;
      }
      layout = result.get();
      layouts.insert(key,result.release());
    }
    int count = layout->wholePage ? 1 : int(layout->rectangles.size());
    if (p.size()==5) {
      Arr figures;
      for (int i=0; i<count; ++i)
        figures.append(Obj{{"index",i},{"kind",layout->wholePage ? "page" : "figure"}});
      c.json(Obj{{"figures",figures}});
      return true;
    }
    index = p[5].toInt(&ok);
    require(ok && index>=0 && index<count && p[5]==QString::number(index),404,"图像不存在。");
    full = layout->wholePage;
  }
  auto jpeg = original(key,pdf,p[4],temp.path());
  if (!full) {
    auto img = QImage::fromData(jpeg,"JPEG");
    require(!img.isNull(),500,"无法打开原页图像。");
    auto region = layout->rectangles[index];
    double sx=double(img.width())/layout->size.width(), sy=double(img.height())/layout->size.height();
    // Crop only when the graphics layer and final rendered page share the same orientation.
    if (qAbs(sx/sy-1) < .02) {
      QRectF projected(region.x()*sx,region.y()*sy,region.width()*sx,region.height()*sy);
      QByteArray crop;
      QBuffer out(&crop);
      out.open(QIODevice::WriteOnly);
      require(img.copy(projected.toAlignedRect()).save(&out,"JPEG",90),500,"无法生成插图。");
      jpeg = crop;
    }
  }
  c.res.set_header("Cache-Control","private, max-age=86400");
  c.res.set_content(jpeg.toStdString(),"image/jpeg");
  return true;
}
