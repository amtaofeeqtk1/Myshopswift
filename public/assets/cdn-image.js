// MyShopSwift — optimised Cloudinary image URLs.
//
// cdnImg(url, width) asks Cloudinary for a version of the image no wider than
// `width` px, in the best format the visitor's browser supports (WebP/AVIF) at
// automatic quality — so phones download a few KB instead of the full upload.
// It only rewrites plain Cloudinary URLs; legacy "assets/..." paths, old
// "/uploads/..." URLs, blob: previews and anything else are returned untouched.
(function () {
  var RE = /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/.+)$/;
  window.cdnImg = function (url, width) {
    if (typeof url !== "string" || !width) return url;
    var m = RE.exec(url);
    return m ? m[1] + "f_auto,q_auto,c_limit,w_" + width + "/" + m[2] : url;
  };
})();
