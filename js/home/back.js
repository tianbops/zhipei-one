/* home/back.js —— 本页返回层级注册：上传 Bottom Sheet → 下拉菜单
   中央返回控制器在 js/ui/back.js，读取 window.zpBackHooks。 */

// 首页的「两次返回才退出」与系统返回已统一到 ui-unified.js 中央控制器。
// 这里只注册本页返回层级：上传 Bottom Sheet → 下拉菜单。
(window.zpBackHooks=window.zpBackHooks||[]).push(
  {rank:10,probe:()=>$("uploadArea"),close:()=>{
     // 运单正在处理中：拒绝关闭，绝不穿透到「退出应用」
     if(typeof processingFile!=="undefined"&&processingFile){
       try{window.zpToast?window.zpToast("运单处理中，请稍候","error"):0}catch{}
       return false;
     }
     closeUpload();return true;
   }},
);