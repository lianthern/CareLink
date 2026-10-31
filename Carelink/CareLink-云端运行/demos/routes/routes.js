const world = (id, splat100, splat500, thumb, pano) => ({
  id,
  marbleUrl: `https://marble.worldlabs.ai/world/${id}`,
  thumbnailUrl: `https://cdn.marble.worldlabs.ai/${id}/${thumb}`,
  panoramaUrl: `https://cdn.marble.worldlabs.ai/${id}/${pano}`,
  splats: {
    preview: `https://cdn.marble.worldlabs.ai/${id}/${splat100}`,
    standard: `https://cdn.marble.worldlabs.ai/${id}/${splat500}`
  }
});

export const routes = [
  {
    id: "dap",
    kicker: "01",
    title: "DAP 深度漫游",
    copy: "最早一条路：一张全景，算出深度，人可以在照片里探身走动。",
    examples: [
      {
        id: "dap-live",
        name: "宴会厅",
        place: "走进全景",
        date: "2026.08",
        route: "DAP",
        viewer: "frame",
        cover: "https://unseen.maxxam.xyz/app-spatial/v1/ballroom.jpg",
        href: "https://unseen.maxxam.xyz/unseen-dap"
      },
      {
        id: "dap-chufa",
        name: "出发",
        place: "婚礼节点",
        date: "2026.07",
        route: "DAP",
        viewer: "pano",
        cover: "./dap/chufa.jpg",
        panorama: "./dap/chufa.jpg"
      },
      {
        id: "dap-jieqin",
        name: "接亲",
        place: "婚礼节点",
        date: "2026.07",
        route: "DAP",
        viewer: "pano",
        cover: "./dap/jieqin.jpg",
        panorama: "./dap/jieqin.jpg"
      },
      {
        id: "dap-yanxi",
        name: "宴席",
        place: "婚礼节点",
        date: "2026.07",
        route: "DAP",
        viewer: "pano",
        cover: "./dap/yanxi.jpg",
        panorama: "./dap/yanxi.jpg"
      },
      {
        id: "dap-yishi",
        name: "仪式",
        place: "婚礼节点",
        date: "2026.07",
        route: "DAP",
        viewer: "pano",
        cover: "./dap/yishi.jpg",
        panorama: "./dap/yishi.jpg"
      },
      {
        id: "dap-chapel",
        name: "教堂",
        place: "全景深度",
        date: "2026.08",
        route: "DAP",
        viewer: "pano",
        cover: "https://unseen.maxxam.xyz/app-spatial/v1/chapel_day.jpg",
        panorama: "https://unseen.maxxam.xyz/app-spatial/v1/chapel_day.jpg"
      },
      {
        id: "dap-cafe",
        name: "咖啡馆",
        place: "全景深度",
        date: "2026.08",
        route: "DAP",
        viewer: "pano",
        cover: "https://unseen.maxxam.xyz/app-spatial/v1/comfy_cafe.jpg",
        panorama: "https://unseen.maxxam.xyz/app-spatial/v1/comfy_cafe.jpg"
      },
      {
        id: "dap-hall",
        name: "大厅",
        place: "全景深度",
        date: "2026.08",
        route: "DAP",
        viewer: "pano",
        cover: "https://unseen.maxxam.xyz/app-spatial/v1/entrance_hall.jpg",
        panorama: "https://unseen.maxxam.xyz/app-spatial/v1/entrance_hall.jpg"
      },
      {
        id: "dap-workshop",
        name: "车间",
        place: "全景深度",
        date: "2026.07",
        route: "DAP",
        viewer: "pano",
        cover: "./dap/demo-pano.jpg",
        panorama: "./dap/demo-pano.jpg"
      }
    ]
  },
  {
    id: "gs",
    kicker: "02",
    title: "3DGS 高斯重建",
    copy: "下一条路：用 360 视频、手机视频或全景序列，重建一个可以走进去的高斯空间。",
    examples: [
      {
        id: "gs-insta-1757",
        name: "影石全景 · 17:57",
        place: "360 视频重建",
        date: "2026.09.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-d006f3967250.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-d006f3967250/"
      },
      {
        id: "gs-insta-1842",
        name: "影石全景 · 18:42",
        place: "360 视频重建",
        date: "2026.09.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-4e8b9dc3817c.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-4e8b9dc3817c/"
      },
      {
        id: "gs-phone",
        name: "手机视频",
        place: "普通视频重建",
        date: "2026.09.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-0b7786edeeb9.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-0b7786edeeb9/"
      },
      {
        id: "event-landscape",
        name: "婚礼空间 · 横屏",
        place: "影石 3D 空间",
        date: "2026.09.16",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-4e8b9dc3817c.jpg",
        href: "https://spaces.maxxam.xyz/events/desktop/"
      },
      {
        id: "event-portrait",
        name: "婚礼空间 · 竖屏",
        place: "影石 3D 空间",
        date: "2026.09.16",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-d006f3967250.jpg",
        href: "https://spaces.maxxam.xyz/events/m/"
      },
      {
        id: "omni-alley",
        name: "街巷",
        place: "360 视频重建",
        date: "2026.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-8a853eed7147.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-8a853eed7147/"
      },
      {
        id: "omni-church",
        name: "教堂外景",
        place: "360 视频重建",
        date: "2026.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-aaff992ddb8c.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-aaff992ddb8c/"
      },
      {
        id: "pandora",
        name: "室内咖啡间",
        place: "全景序列重建",
        date: "2026.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-8af1691afe40.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-8af1691afe40/"
      },
      {
        id: "hkust",
        name: "校园外景",
        place: "全景序列重建",
        date: "2026.09",
        route: "3DGS",
        viewer: "frame",
        cover: "https://spaces.maxxam.xyz/spaces/covers/scene-3aafc6cc274a.jpg",
        href: "https://spaces.maxxam.xyz/spaces/view/scene-3aafc6cc274a/"
      }
    ]
  },
  {
    id: "worldlab",
    kicker: "03",
    title: "World Labs 生成",
    copy: "现在这条路：几张照片或一段视频，直接生成一个可以走进去的世界。",
    examples: [
      {
        id: "wl-castle-multi",
        name: "城堡 · 八图",
        place: "多图生成",
        date: "2026.09.03",
        route: "World Labs",
        viewer: "world",
        cover: "./covers/castle-multi.jpg",
        world: {
          id: "585ed6bd-7c49-4460-aac0-104f878af2f1",
          marbleUrl: "https://marble.worldlabs.ai/world/585ed6bd-7c49-4460-aac0-104f878af2f1",
          thumbnailUrl: "./covers/castle-multi.jpg",
          splats: {
            preview: "https://cdn.marble.worldlabs.ai/585ed6bd-7c49-4460-aac0-104f878af2f1/df16e4b7-64cf-44e6-a3bd-a8c7e23926af_sand_100k.spz",
            standard: "https://cdn.marble.worldlabs.ai/585ed6bd-7c49-4460-aac0-104f878af2f1/f308a552-6c02-4b4b-9c16-a40f14a032a3_sand_500k.spz"
          }
        }
      },
      {
        id: "wl-castle-single",
        name: "城堡 · 单图",
        place: "单图生成",
        date: "2026.09.03",
        route: "World Labs",
        viewer: "world",
        cover: "./covers/castle-single.jpg",
        world: {
          id: "a6755a78-656b-4e3e-b78b-7eca5b903864",
          marbleUrl: "https://marble.worldlabs.ai/world/a6755a78-656b-4e3e-b78b-7eca5b903864",
          thumbnailUrl: "./covers/castle-single.jpg",
          splats: {
            preview: "https://cdn.marble.worldlabs.ai/a6755a78-656b-4e3e-b78b-7eca5b903864/85d35e8c-731f-4030-9940-1da1519a7f37_sand_100k.spz",
            standard: "https://cdn.marble.worldlabs.ai/a6755a78-656b-4e3e-b78b-7eca5b903864/6efcaad5-0186-4541-8004-646eecccb5a6_sand_500k.spz"
          }
        }
      },
      {
        id: "wl-stranger",
        name: "城堡 · 三图",
        place: "多图生成",
        date: "2026.09.11",
        route: "World Labs",
        viewer: "world",
        world: world(
          "6cd2492c-a891-4a66-b27d-77d9f643be21",
          "26788c91-bfa1-4c37-bea3-64e895633aa7_sand_100k.spz",
          "885503d1-b6fd-4e5c-baab-8ab280c6f0b5_sand_500k.spz",
          "91bc89a8-58ae-48d0-92c2-f24b0d7e6da8_sand_mpi/thumbnail.webp",
          "4fc51afc-f423-4a74-9c97-5101c8cb74e6_pano/rgb_0.png"
        )
      },
      {
        id: "wl-kitchen",
        name: "厨房",
        place: "单图生成",
        date: "2026.09.05",
        route: "World Labs",
        viewer: "world",
        world: world(
          "1e019f98-86d9-4e7a-b360-044ef9c48c27",
          "bb9609e8-002e-4803-a67f-70166223c59f_sand_100k.spz",
          "69c56452-86a1-4d50-b5f8-cf11228a41c7_sand_500k.spz",
          "fa00ec9f-c9ec-495c-aea3-182d8c863cf4_sand_mpi/thumbnail.webp",
          "486a36cb-a176-4ba0-b838-b0e3d2ceb149_pano/rgb_0.png"
        )
      },
      {
        id: "wl-meeting",
        name: "会议室",
        place: "多图生成",
        date: "2026.09.11",
        route: "World Labs",
        viewer: "world",
        world: world(
          "5b1fd4bd-454e-40ba-aaa5-4788f93f0d55",
          "fc55761b-f9e3-4d0f-b76a-dc995089576d_sand_100k.spz",
          "d6b1404b-a6bb-4f36-bd42-fa7dcf144c6b_sand_500k.spz",
          "dc6054e2-5900-43f3-90e5-c216447ae90f_sand_mpi/thumbnail.webp",
          "12db91f2-36ff-4d74-8e2d-b69987a10ab4_pano/rgb_0.png"
        )
      },
      {
        id: "wl-grad-trip",
        name: "会议室 · 二",
        place: "多图生成",
        date: "2026.09.12",
        route: "World Labs",
        viewer: "world",
        world: world(
          "a50e2924-7ff4-4dba-84de-7bc10874e12f",
          "f718bdcb-2151-4a1a-97c6-f3ae9ea58fa3_sand_100k.spz",
          "4ee8e819-c77a-4e22-a1c5-c2a3bd68c1ae_sand_500k.spz",
          "d17bdb35-ffbc-4fe3-af70-c06718dd0526_sand_mpi/thumbnail.webp",
          "040d30dd-ec10-403d-9f2e-54580785e6cd_pano/rgb_0.png"
        )
      },
      {
        id: "wl-tum-3",
        name: "办公室 · 三图",
        place: "多图生成",
        date: "2026.09.12",
        route: "World Labs",
        viewer: "world",
        world: {
          id: "7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7",
          marbleUrl: "https://marble.worldlabs.ai/world/7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7",
          thumbnailUrl: "https://cdn.marble.worldlabs.ai/7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7/cb386942-255e-4d5a-a069-c0c020b006fa_sand_mpi/thumbnail.webp",
          panoramaUrl: "https://cdn.marble.worldlabs.ai/7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7/6cf20106-b252-437a-9bd3-1166e88b1dfc_panos/rgb_0.png",
          splats: {
            preview: "https://cdn.marble.worldlabs.ai/7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7/9c036a05-b436-40f0-ab7b-114e6e9b84e8_dust_100k.spz",
            standard: "https://cdn.marble.worldlabs.ai/7c58db8a-0b09-4e13-a749-a9c8b8ef5fc7/5bafcf74-062b-4a7e-870d-48b6ba1c7477_ceramic_500k.spz"
          }
        }
      },
      {
        id: "wl-tum-5",
        name: "办公室 · 五图",
        place: "多图生成",
        date: "2026.09.12",
        route: "World Labs",
        viewer: "world",
        world: {
          id: "ab1c3b71-99e3-4780-a940-e47a6e7c7489",
          marbleUrl: "https://marble.worldlabs.ai/world/ab1c3b71-99e3-4780-a940-e47a6e7c7489",
          thumbnailUrl: "https://cdn.marble.worldlabs.ai/ab1c3b71-99e3-4780-a940-e47a6e7c7489/f3be93dd-f287-4f9c-8b09-b1ae41c3bec6_sand_mpi/thumbnail.webp",
          panoramaUrl: "https://cdn.marble.worldlabs.ai/ab1c3b71-99e3-4780-a940-e47a6e7c7489/52ea613b-0d2d-4878-9ad7-e4992dce8183_panos/rgb_0.png",
          splats: {
            preview: "https://cdn.marble.worldlabs.ai/ab1c3b71-99e3-4780-a940-e47a6e7c7489/e11c6de5-1869-4f45-b7c6-940531ca5bc4_dust_100k.spz",
            standard: "https://cdn.marble.worldlabs.ai/ab1c3b71-99e3-4780-a940-e47a6e7c7489/115e8629-5589-4f69-8c22-9ac3f63a6956_ceramic_500k.spz"
          }
        }
      },
      {
        id: "wl-tum-video",
        name: "办公室 · 视频",
        place: "视频生成",
        date: "2026.09.12",
        route: "World Labs",
        viewer: "world",
        world: {
          id: "840f174e-228f-417d-8ba5-c55331e5b70f",
          marbleUrl: "https://marble.worldlabs.ai/world/840f174e-228f-417d-8ba5-c55331e5b70f",
          thumbnailUrl: "https://cdn.marble.worldlabs.ai/840f174e-228f-417d-8ba5-c55331e5b70f/7a659f52-a479-4d21-b61a-638590fb3f31_sand_mpi/thumbnail.webp",
          panoramaUrl: "https://cdn.marble.worldlabs.ai/840f174e-228f-417d-8ba5-c55331e5b70f/aba0613e-b30e-4741-b99b-e8bbafe1275b_panos/rgb_0.png",
          splats: {
            preview: "https://cdn.marble.worldlabs.ai/840f174e-228f-417d-8ba5-c55331e5b70f/64bc3204-cf4a-4114-93ec-d0e5f7ed12db_dust_100k.spz",
            standard: "https://cdn.marble.worldlabs.ai/840f174e-228f-417d-8ba5-c55331e5b70f/65ad409d-98ed-4d31-8aba-608488c58914_ceramic_500k.spz"
          }
        }
      }
    ]
  }
];
