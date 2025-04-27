import express from 'express';
const router = express.Router();

// Routes
import getRouter from './get';

// Types
import type GlobalObject from 'types/GlobalObject';

const routerInvoker = (global: GlobalObject) => {
  router.use('/get', getRouter(global));

  return router;
};

export default routerInvoker;
