#pragma once

class Database;
struct Context;
void initializeProjects(Database &);
bool projectRoutes(Context &);

struct ProjectWorker {
  ProjectWorker();
  ~ProjectWorker();
};
