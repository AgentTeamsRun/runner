const timestamp = () => new Date().toISOString();

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    if (meta) {
      console.log(`[${timestamp()}] INFO ${message}`, meta);
      return;
    }

    console.log(`[${timestamp()}] INFO ${message}`);
  },

  warn: (message: string, meta?: Record<string, unknown>) => {
    if (meta) {
      console.warn(`[${timestamp()}] WARN ${message}`, meta);
      return;
    }

    console.warn(`[${timestamp()}] WARN ${message}`);
  },

  error: (message: string, meta?: Record<string, unknown>) => {
    if (meta) {
      console.error(`[${timestamp()}] ERROR ${message}`, meta);
      return;
    }

    console.error(`[${timestamp()}] ERROR ${message}`);
  }
};
