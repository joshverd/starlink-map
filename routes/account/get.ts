import express from 'express';
const router = express.Router();

// Types
import type GlobalObject from 'types/GlobalObject'; 

const routerInvoker = (global: GlobalObject) => {
  router.get('/', (req, res) => {
    return res.send({
      success: true,
      data: {
        userID: 1,
      },
    });
  });

  return router;
};

export default routerInvoker;
