export interface Task {
  id: number;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  createdAt: string;
  updatedAt: string;
}

export class TaskStore {
  readonly #tasks: Task[] = [];
  #nextId = 1;

  create(title: string, description?: string): Task {
    const now = new Date().toISOString();
    const task: Task = {
      createdAt: now,
      description: description ?? '',
      id: this.#nextId++,
      status: 'pending',
      title,
      updatedAt: now,
    };
    this.#tasks.push(task);
    return task;
  }

  complete(id: number): Task {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task #${id} not found`);
    }
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    return task;
  }

  skip(id: number): Task {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task #${id} not found`);
    }
    task.status = 'skipped';
    task.updatedAt = new Date().toISOString();
    return task;
  }

  edit(id: number, patch: { title?: string; description?: string }): Task {
    const task = this.#tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task #${id} not found`);
    }
    if (patch.title !== undefined) {
      task.title = patch.title;
    }
    if (patch.description !== undefined) {
      task.description = patch.description;
    }
    task.updatedAt = new Date().toISOString();
    return task;
  }

  delete(id: number): Task {
    const idx = this.#tasks.findIndex((t) => t.id === id);
    if (idx === -1) {
      throw new Error(`Task #${id} not found`);
    }
    const [task] = this.#tasks.splice(idx, 1);
    return task;
  }

  list(status?: Task['status']): Task[] {
    if (status) {
      return this.#tasks.filter((t) => t.status === status);
    }
    return [...this.#tasks];
  }

  get(id: number): Task | undefined {
    return this.#tasks.find((t) => t.id === id);
  }
}
